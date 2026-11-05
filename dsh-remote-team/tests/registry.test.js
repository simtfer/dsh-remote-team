import test from 'node:test'
import assert from 'node:assert/strict'
import { MachineRegistry } from '../src/registry.js'
import { normalizeConfig } from '../src/config.js'
import { baseConfig } from './helpers.js'

function makeRegistry(remoteExec) {
  return new MachineRegistry({ config: normalizeConfig(baseConfig()), remoteExec })
}

test('list reports unknown status until probed', () => {
  const registry = makeRegistry(undefined)
  assert.deepEqual(registry.list().map((row) => row.status), ['unknown', 'unknown'])
})

test('refresh merges live status and never throws on probe failure', async () => {
  const registry = makeRegistry({
    listMachines: () => [
      { id: 'dev-win', status: 'online', platform: 'windows' },
      { id: 'build-win', status: 'offline', platform: 'windows' },
    ],
    probe: async (id) => {
      if (id === 'build-win') throw new Error('unreachable')
      return { id, status: 'online', platform: 'windows' }
    },
  })
  const rows = await registry.refresh(new AbortController().signal)
  assert.equal(rows[0].status, 'online')
  assert.equal(rows[1].status, 'offline')
  assert.equal(rows[1].error, 'unreachable')
})

test('explicit machine always wins and unknown ids are rejected', async () => {
  const registry = makeRegistry({
    listMachines: () => [],
    probe: async (id) => ({ id, status: 'online' }),
  })
  await registry.refresh()
  const route = registry.route({ machine: 'build-win' })
  assert.equal(route.id, 'build-win')
  assert.deepEqual(route.reasons, ['explicit machine'])
  assert.throws(() => registry.route({ machine: 'nope' }), /unknown machine/)
})

test('automatic routing prefers online machines and respects tags', async () => {
  const registry = makeRegistry({
    listMachines: () => [],
    probe: async (id) => ({ id, status: id === 'dev-win' ? 'online' : 'offline' }),
  })
  await registry.refresh()
  const plain = registry.route({})
  assert.equal(plain.id, 'dev-win')
  assert.ok(plain.reasons.some((reason) => reason.includes('online')))

  const tagged = registry.route({ tags: ['build'] })
  // The offline machine loses 1000 points, so even a tag match cannot win.
  assert.equal(tagged.id, 'dev-win')
  assert.ok(Array.isArray(tagged.scores))
})

test('capacity gating is per machine and outcome history affects scores', () => {
  const registry = makeRegistry(undefined)
  const release = registry.acquire('build-win')
  assert.equal(typeof release, 'function')
  assert.equal(registry.acquire('build-win'), undefined)
  release()
  assert.equal(typeof registry.acquire('build-win'), 'function')

  registry.noteOutcome('dev-win', 'settled')
  registry.noteOutcome('build-win', 'failed')
  registry.noteOutcome('build-win', 'failed')
  const withHistory = registry.route({})
  assert.ok(withHistory.reasons.some((reason) => reason.includes('success rate')))
})

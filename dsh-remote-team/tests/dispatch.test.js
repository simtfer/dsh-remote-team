import test from 'node:test'
import assert from 'node:assert/strict'
import { normalizeConfig } from '../src/config.js'
import { MachineRegistry } from '../src/registry.js'
import { RunStore } from '../src/run-store.js'
import { DispatchPolicy } from '../src/policy.js'
import { RemoteDispatcher } from '../src/dispatch.js'
import { baseConfig, completedActivation, fakeExec, pendingActivation } from './helpers.js'

function setup({ activationFactory, configOverrides, remoteExec } = {}) {
  const config = normalizeConfig(baseConfig(configOverrides))
  const registry = new MachineRegistry({ config, remoteExec })
  const store = new RunStore(':memory:')
  const policy = new DispatchPolicy({ config, registry })
  const calls = []
  const ctx = {
    logger: { info() {}, warn() {}, error() {} },
    subagents: {
      async startActivation(spec) {
        calls.push(spec)
        return activationFactory === undefined ? completedActivation('REMOTE PONG') : activationFactory(spec)
      },
    },
  }
  const dispatcher = new RemoteDispatcher({ ctx, config, registry, store, policy })
  return { dispatcher, registry, store, calls, config }
}

test('wait=true returns the remote answer and forwards the remote cwd', async () => {
  const s = setup()
  const result = await s.dispatcher.run({ machine: 'dev-win', task: 'reply PONG', wait: true }, fakeExec())
  assert.equal(result.ok, true)
  assert.equal(result.status, 'settled')
  assert.equal(result.output, 'REMOTE PONG')
  assert.equal(result.machine, 'dev-win')
  assert.equal(s.calls.length, 1)
  assert.equal(s.calls[0].delivery, 'caller')
  assert.equal(s.calls[0].provider, 'pi@dev-win')
  assert.equal(s.calls[0].request.cwd, 'D:\\work\\repo')
  assert.deepEqual(s.calls[0].request.prompt, [{ type: 'text', text: 'reply PONG' }])
})

test('explicit cwd overrides the configured machine cwd', async () => {
  const s = setup()
  await s.dispatcher.run({ machine: 'dev-win', task: 'x', cwd: 'D:\\other', wait: true }, fakeExec())
  assert.equal(s.calls[0].request.cwd, 'D:\\other')
})

test('omitting machine routes automatically and exposes the reasons', async () => {
  const s = setup({
    remoteExec: {
      listMachines: () => [],
      probe: async (id) => ({ id, status: 'online', platform: 'windows' }),
    },
  })
  await s.dispatcher.registry.refresh()
  const result = await s.dispatcher.run({ task: 'x', wait: true }, fakeExec())
  assert.equal(result.ok, true)
  assert.ok(['dev-win', 'build-win'].includes(result.machine))
  assert.ok(Array.isArray(result.reasons))
})

test('non-completed stopReason becomes a failed result', async () => {
  const s = setup({ activationFactory: () => completedActivation('partial', 'error') })
  const result = await s.dispatcher.run({ machine: 'dev-win', task: 'x', wait: true }, fakeExec())
  assert.equal(result.ok, false)
  assert.equal(result.status, 'failed')
  assert.equal(result.stopReason, 'error')
})

test('OUTCOME_UNKNOWN is recorded as unknown and never replayed', async () => {
  const s = setup({
    activationFactory: () => {
      const pending = pendingActivation()
      queueMicrotask(() => pending.reject(Object.assign(new Error('link closed'), { code: 'OUTCOME_UNKNOWN' })))
      return pending.activation
    },
  })
  const result = await s.dispatcher.run({ machine: 'dev-win', task: 'x', wait: true }, fakeExec())
  assert.equal(result.status, 'unknown')
  assert.match(result.diagnostic, /link closed/)
  assert.equal(s.calls.length, 1, 'no automatic replay')
  assert.equal(s.store.get(result.runId).status, 'unknown')
})

test('wait=false returns a runId and status/output become queryable', async () => {
  const s = setup()
  const started = await s.dispatcher.run({ machine: 'dev-win', task: 'x' }, fakeExec())
  assert.equal(started.status, 'streaming')
  assert.ok(started.runId)
  await new Promise((resolve) => setImmediate(resolve))
  const status = s.dispatcher.status(started.runId)
  assert.equal(status.status, 'settled')
  const output = s.dispatcher.output(started.runId, 0)
  assert.equal(output.text, 'REMOTE PONG')
  assert.equal(output.nextCursor, 'REMOTE PONG'.length)
})

test('cancel disposes a live activation and keeps the cancelled state', async () => {
  const pending = pendingActivation()
  const s = setup({ activationFactory: () => pending.activation })
  const started = await s.dispatcher.run({ machine: 'dev-win', task: 'x' }, fakeExec())
  const cancelled = await s.dispatcher.cancel(started.runId)
  assert.equal(cancelled.ok, true)
  assert.equal(cancelled.status, 'cancelled')
  assert.equal(pending.state.disposed, true)
  assert.equal(s.store.get(started.runId).status, 'cancelled')
})

test('parallel fans out to both machines', async () => {
  const s = setup()
  const result = await s.dispatcher.parallel({
    tasks: [
      { machine: 'dev-win', task: 'a' },
      { machine: 'build-win', task: 'b' },
    ],
    wait: true,
  }, fakeExec())
  assert.equal(result.ok, true)
  assert.equal(result.results.length, 2)
  assert.equal(s.calls.length, 2)
})

test('per-machine concurrency limit rejects the second run', async () => {
  const pending = pendingActivation()
  const s = setup({
    activationFactory: () => pending.activation,
    configOverrides: {
      machines: [{
        id: 'dev-win', provider: 'pi@dev-win', url: 'wss://dev-win:8787',
        cwd: 'D:\\work', maxConcurrentRuns: 1,
      }],
    },
  })
  const first = await s.dispatcher.run({ machine: 'dev-win', task: 'a' }, fakeExec())
  assert.equal(first.status, 'streaming')
  const second = await s.dispatcher.run({ machine: 'dev-win', task: 'b' }, fakeExec())
  assert.equal(second.ok, false)
  assert.match(second.reason, /concurrency limit/)
  assert.equal(s.calls.length, 1)
})

test('missing calling agent is a hard error', async () => {
  const s = setup()
  await assert.rejects(
    () => s.dispatcher.run({ machine: 'dev-win', task: 'x' }, {}),
    /requires a calling agent/,
  )
})

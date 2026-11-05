import test from 'node:test'
import assert from 'node:assert/strict'
import { normalizeConfig, validateMachineUrl, resolveRunStorePath } from '../src/config.js'
import { baseConfig } from './helpers.js'

test('normalizes a valid two-machine config', () => {
  const config = normalizeConfig(baseConfig())
  assert.equal(config.machines.length, 2)
  assert.equal(config.teamProvider, 'spawn')
  assert.equal(config.maxParallel, 4)
  assert.deepEqual(config.machines[0].tags, ['dev'])
  assert.equal(Object.isFrozen(config), true)
})

test('accepts wss:// and loopback ws://, rejects non-loopback ws://', () => {
  assert.equal(validateMachineUrl('wss://dev-win:8787', 'm'), 'wss')
  assert.equal(validateMachineUrl('ws://127.0.0.1:8787', 'm'), 'ws-loopback')
  assert.equal(validateMachineUrl('ws://localhost:8787', 'm'), 'ws-loopback')
  assert.throws(() => validateMachineUrl('ws://192.168.1.20:8787', 'm'), /plaintext ws:\/\//)
  assert.throws(() => validateMachineUrl('http://dev-win:8787', 'm'), /ws:\/\/ or wss:\/\//)
  assert.throws(() => normalizeConfig(baseConfig({
    machines: [{ id: 'bad', provider: 'pi@bad', url: 'ws://10.0.0.5:8787', cwd: 'D:\\work' }],
  })), /plaintext ws:\/\//)
})

test('rejects duplicate ids, relative cwd, and invalid limits', () => {
  assert.throws(() => normalizeConfig(baseConfig({
    machines: [
      { id: 'a', provider: 'pi@a', cwd: 'D:\\a' },
      { id: 'a', provider: 'pi@b', cwd: 'D:\\b' },
    ],
  })), /configured twice/)
  assert.throws(() => normalizeConfig(baseConfig({
    machines: [{ id: 'a', provider: 'pi@a', cwd: 'relative/path' }],
  })), /absolute path/)
  assert.throws(() => normalizeConfig(baseConfig({ maxParallel: 9 })), /between 1 and 8/)
})

test('run store path defaults under DSH_HOME when set', () => {
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = 'D:\\dsh-home'
  try {
    assert.equal(resolveRunStorePath(), 'D:\\dsh-home/remote-team/runs.jsonl')
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
  }
  assert.equal(resolveRunStorePath('D:\\custom\\runs.jsonl'), 'D:\\custom\\runs.jsonl')
})

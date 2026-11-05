import test from 'node:test'
import assert from 'node:assert/strict'
import { apply } from '../index.js'
import { baseConfig, completedActivation, fakeExec, makeContext, toolByName } from './helpers.js'

function setup({ agentTeams } = {}) {
  const subagents = { async startActivation() { return completedActivation('REMOTE PONG') } }
  const harness = makeContext({ subagents, agentTeams })
  apply(harness.ctx, baseConfig())
  return harness
}

test('activates with exactly ten registered tools', () => {
  const harness = setup()
  assert.equal(harness.tools.length, 10)
  const names = harness.tools.map((tool) => tool.name)
  assert.ok(names.includes('remote_team_run'))
  assert.ok(names.includes('spawn_remote_teammate'))
  for (const tool of harness.tools) {
    assert.equal(tool.parameters.type, 'object')
    assert.equal(typeof tool.execute, 'function')
    assert.equal(typeof tool.output.render, 'function')
    assert.equal(Array.isArray(tool.output.render({}, { ok: true })), true)
  }
})

test('remote_team_list and remote_team_route are usable through execute()', async () => {
  const harness = setup()
  const list = await toolByName(harness.tools, 'remote_team_list').execute({}, fakeExec())
  assert.equal(list.ok, true)
  assert.equal(list.machines.length, 2)
  const route = await toolByName(harness.tools, 'remote_team_route').execute({}, fakeExec())
  assert.equal(route.ok, true)
  assert.ok(route.id)
})

test('remote_team_run reaches the mocked Pi provider', async () => {
  const harness = setup()
  const tool = toolByName(harness.tools, 'remote_team_run')
  const result = await tool.execute({ machine: 'dev-win', task: 'reply PONG', wait: true }, fakeExec())
  assert.equal(result.output, 'REMOTE PONG')
  assert.equal(result.ok, true)
})

test('missing required argument is rejected before dispatch', async () => {
  const harness = setup()
  const tool = toolByName(harness.tools, 'remote_team_run')
  await assert.rejects(() => tool.execute({}, fakeExec()), /missing required argument "task"/)
  await assert.rejects(() => tool.execute({ task: 'x', bogus: 1 }, fakeExec()), /unexpected argument "bogus"/)
})

test('spawn_remote_teammate binds a local teammate to a machine', async () => {
  let received
  const harness = setup({
    agentTeams: {
      async spawnTeammate(agent, spec) {
        received = { agent, spec }
        return { member: { name: spec.name, id: 'child-1', phase: 'active' } }
      },
    },
  })
  const tool = toolByName(harness.tools, 'spawn_remote_teammate')
  const result = await tool.execute({
    name: 'win-worker', description: 'remote work', prompt: 'check the build', machine: 'build-win',
  }, fakeExec())
  assert.equal(result.ok, true)
  assert.equal(result.machine, 'build-win')
  assert.equal(result.member.name, 'win-worker')
  assert.equal(received.spec.context, 'fresh')
  assert.equal(received.spec.provider, 'spawn')
  assert.match(received.spec.prompt[0].text, /Bound machine: build-win/)
  assert.match(received.spec.prompt[0].text, /Do not modify files on the local host/)
})

test('spawn_remote_teammate degrades cleanly when agent-team is absent', async () => {
  const harness = setup()
  const result = await toolByName(harness.tools, 'spawn_remote_teammate').execute({
    name: 'win-worker', description: 'remote work', prompt: 'check the build', machine: 'dev-win',
  }, fakeExec())
  assert.equal(result.ok, false)
  assert.match(result.reason, /agentTeams is unavailable/)
})

test('assign_remote_task uses the teammate machine binding', async () => {
  const harness = setup({
    agentTeams: { async spawnTeammate(_agent, spec) { return { member: { name: spec.name } } } },
  })
  await toolByName(harness.tools, 'spawn_remote_teammate').execute({
    name: 'win-worker', description: 'remote work', prompt: 'check the build', machine: 'dev-win',
  }, fakeExec())
  const result = await toolByName(harness.tools, 'assign_remote_task').execute({
    member: 'win-worker', task: 'reply PONG', wait: true,
  }, fakeExec())
  assert.equal(result.output, 'REMOTE PONG')
  assert.equal(result.machine, 'dev-win')
})

test('disposing the fiber unregisters every tool', () => {
  const harness = setup()
  assert.equal(harness.tools.length, 10)
  harness.dispose()
  assert.equal(harness.tools.length, 0)
})

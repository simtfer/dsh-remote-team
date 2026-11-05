/**
 * Model-visible tools for the remote agent team. Every definition is a raw
 * ToolDefinition (no defineTool import), so the bundle has zero DSH runtime
 * dependencies and can be unit-tested with a mock context.
 */

import { defineTool } from './tool.js'

const MACHINE_PARAM = {
  type: 'string',
  description: 'Id from remote_team_list. Omit to let the router choose by tags, capacity and status.',
}
const TAGS_PARAM = {
  type: 'array',
  items: { type: 'string' },
  description: 'Optional capability tags used for automatic routing.',
}

export function createTools({ ctx, config, registry, dispatcher, teammates, store }) {
  const tools = []

  tools.push(defineTool({
    name: 'remote_team_list',
    description: 'List configured remote machines with status, tags, capabilities and concurrency. Use this before choosing a machine.',
    parameters: {},
    isConcurrencySafe: () => true,
    async execute() {
      return { ok: true, machines: registry.list(), teammates: teammates.list() }
    },
  }))

  tools.push(defineTool({
    name: 'remote_team_probe',
    description: 'Probe remote machines and refresh their online status. Omit machine to probe all of them.',
    parameters: { machine: MACHINE_PARAM },
    async execute(args, exec) {
      if (args.machine !== undefined && registry.get(args.machine) === undefined) {
        return { ok: false, reason: `unknown machine "${args.machine}"` }
      }
      const machines = await registry.refresh(exec.signal)
      return { ok: true, machines: args.machine === undefined ? machines : machines.filter((row) => row.id === args.machine) }
    },
  }))

  tools.push(defineTool({
    name: 'remote_team_route',
    description: 'Ask which machine the plugin would choose for a task, with the score breakdown. Does not start any work.',
    parameters: { tags: TAGS_PARAM, prefer: { type: 'string', description: 'Preferred machine id or tag.' } },
    isConcurrencySafe: () => true,
    async execute(args) {
      try {
        return { ok: true, ...registry.route({ tags: args.tags, prefer: args.prefer }) }
      } catch (error) {
        return { ok: false, reason: String(error.message ?? error) }
      }
    },
  }))

  tools.push(defineTool({
    name: 'remote_team_run',
    description: 'Run one task on a remote Windows machine using its Pi coding agent. Set wait=true to get the final answer in this call; wait=false returns a runId for polling. This is the single execution entry point.',
    parameters: {
      task: { type: 'string', required: true, description: 'Complete self-contained task text. The remote agent starts fresh and cannot see this conversation.' },
      machine: MACHINE_PARAM,
      tags: TAGS_PARAM,
      prefer: { type: 'string', description: 'Preferred machine id or tag when machine is omitted.' },
      cwd: { type: 'string', description: 'Absolute working directory on the remote machine. Defaults to the configured machine cwd.' },
      wait: { type: 'boolean', description: 'When true, block until the remote run settles and return its output.' },
    },
    async execute(args, exec) {
      return dispatcher.run(args, exec)
    },
  }))

  tools.push(defineTool({
    name: 'remote_team_parallel',
    description: 'Fan out several tasks to remote machines at once and return one summary. Each item may pin its own machine.',
    parameters: {
      tasks: {
        type: 'array',
        required: true,
        minItems: 1,
        items: {
          type: 'object',
          properties: {
            task: { type: 'string' },
            machine: { type: 'string' },
            cwd: { type: 'string' },
            tags: { type: 'array', items: { type: 'string' } },
          },
          required: ['task'],
          additionalProperties: false,
        },
        description: 'Tasks to run concurrently.',
      },
      wait: { type: 'boolean', description: 'Defaults to true: wait for every result.' },
    },
    async execute(args, exec) {
      return dispatcher.parallel(args, exec)
    },
  }))

  tools.push(defineTool({
    name: 'remote_team_status',
    description: 'Check one remote run by runId. An "unknown" status means the connection was lost and the remote outcome is NOT known — do not assume failure.',
    parameters: { runId: { type: 'string', required: true, description: 'runId returned by remote_team_run.' } },
    isConcurrencySafe: () => true,
    async execute(args) {
      return dispatcher.status(args.runId)
    },
  }))

  tools.push(defineTool({
    name: 'remote_team_output',
    description: 'Read the final remote output from a run, optionally from a character cursor.',
    parameters: {
      runId: { type: 'string', required: true },
      cursor: { type: 'number', description: 'Character offset returned as nextCursor by a previous call.' },
    },
    isConcurrencySafe: () => true,
    async execute(args) {
      return dispatcher.output(args.runId, args.cursor ?? 0)
    },
  }))

  tools.push(defineTool({
    name: 'remote_team_cancel',
    description: 'Cancel a still-running remote task. Disposes the activation so the remote agent kills its process tree.',
    parameters: { runId: { type: 'string', required: true } },
    async execute(args) {
      return dispatcher.cancel(args.runId)
    },
  }))

  tools.push(defineTool({
    name: 'spawn_remote_teammate',
    description: 'Create a durable agent-team teammate bound to a remote machine. The teammate is a local DSH agent that executes work through remote_team_run; team messaging, task board and wait_agent keep working. Only the Team Lead should call this.',
    parameters: {
      name: { type: 'string', required: true, description: 'Unique lower-kebab-case teammate name.' },
      description: { type: 'string', required: true, description: 'Short description of this teammate responsibility.' },
      prompt: { type: 'string', required: true, description: 'Complete initial task for the teammate.' },
      machine: MACHINE_PARAM,
      tags: TAGS_PARAM,
    },
    async execute(args, exec) {
      return teammates.spawn(args, exec)
    },
  }))

  tools.push(defineTool({
    name: 'assign_remote_task',
    description: 'Dispatch a task using the machine already bound to a remote teammate. Useful for a second task without re-selecting a machine.',
    parameters: {
      member: { type: 'string', required: true, description: 'Name used in spawn_remote_teammate.' },
      task: { type: 'string', required: true },
      wait: { type: 'boolean', description: 'Defaults to false: return a runId immediately.' },
    },
    async execute(args, exec) {
      return teammates.assign(args, exec)
    },
  }))

  return tools
}

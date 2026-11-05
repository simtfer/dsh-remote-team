/**
 * Local proxy teammates — the only way to put remote execution into DSH's
 * built-in agent-team roster.
 *
 * Why: spawn_teammate reserves a childId, and ctx.subagents.startActivation()
 * requires a provider with prepareContinuable(). That provider's ONLY job is
 * returning a seed; the continuation manager always creates a local in-process
 * Agent. So a remote Pi process can never be a roster member directly.
 * Instead we spawn a normal local teammate and give it one job: call
 * remote_team_run on its bound machine and report the result as its answer.
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { optionalService } from './services.js'

const DEFAULT_PERSONA = [
  'You are a remote execution teammate in this DSH agent-team.',
  'Your work is performed on ANOTHER computer by a Pi coding agent.',
  'Rules:',
  '1. Do not modify files on the local host. All real work must go through remote_team_run.',
  '2. Always pass the machine id shown below unless the Team Lead explicitly says otherwise.',
  '3. Treat the text returned by remote_team_run as the ground truth; report it as your answer.',
  '4. If a run returns "unknown", say the remote outcome is unknown and give the runId; never guess or silently retry.',
  '5. For follow-up questions from the Lead, answer from previous results or start a NEW remote_team_run. You are a live teammate, not a one-shot process.',
].join('\n')

const PERSONA_PATH = fileURLToPath(new URL('../presets/remote-worker.md', import.meta.url))
let cachedPersona

/** Operator-editable persona; falls back to the built-in one if the file is missing. */
export function workerPersona() {
  if (cachedPersona === undefined) {
    try {
      const text = readFileSync(PERSONA_PATH, 'utf8').trim()
      cachedPersona = text.length > 0 ? text : DEFAULT_PERSONA
    } catch {
      cachedPersona = DEFAULT_PERSONA
    }
  }
  return cachedPersona
}

function pickupPrimitives(value) {
  const result = {}
  if (value === null || typeof value !== 'object') return result
  for (const [key, entry] of Object.entries(value)) {
    if (Object.keys(result).length >= 12) break
    if (['string', 'number', 'boolean'].includes(typeof entry)) result[key] = entry
  }
  return result
}

export class ProxyTeammates {
  /** @param {{ctx: object, config: object, registry: object, dispatcher: object, logger?: object}} deps */
  constructor({ ctx, config, registry, dispatcher, logger }) {
    this.ctx = ctx
    this.config = config
    this.registry = registry
    this.dispatcher = dispatcher
    this.logger = logger
    this.bindings = new Map()
  }

  teamService() {
    return optionalService(this.ctx, 'agentTeams')
  }

  /** Create one durable local teammate bound to a remote machine. */
  async spawn(args, exec) {
    const teams = this.teamService()
    if (teams?.spawnTeammate === undefined) {
      return { ok: false, reason: 'ctx.agentTeams is unavailable: enable the dsh agent-team bundle for this profile' }
    }
    if (exec?.agent === undefined || exec.agent === null) {
      throw new Error('spawn_remote_teammate requires a calling agent (exec.agent was undefined)')
    }
    let route
    try {
      route = this.registry.route({ machine: args.machine, tags: args.tags })
    } catch (error) {
      return { ok: false, reason: String(error.message ?? error) }
    }
    if (this.bindings.has(args.name)) {
      return { ok: false, reason: `teammate "${args.name}" is already bound in this plugin instance` }
    }

    const machine = this.registry.get(route.id)
    const prompt = [
      workerPersona(),
      '',
      `Bound machine: ${route.id} (${machine.name})`,
      `Machine working directory: ${machine.cwd}`,
      `Team Lead's initial task: ${args.prompt}`,
      '',
      `Start by calling remote_team_run({ machine: "${route.id}", task: <the task>, wait: true }).`,
    ].join('\n')

    try {
      const result = await teams.spawnTeammate(exec.agent, {
        name: args.name,
        description: args.description,
        prompt: [{ type: 'text', text: prompt }],
        context: 'fresh',
        provider: this.config.teamProvider,
        signal: exec.signal,
      })
      this.bindings.set(args.name, {
        machine: route.id,
        tags: args.tags ?? [],
        description: args.description,
        createdAt: new Date().toISOString(),
      })
      return {
        ok: true,
        machine: route.id,
        routingReasons: route.reasons,
        member: pickupPrimitives(result?.member ?? result),
      }
    } catch (error) {
      return { ok: false, reason: String(error?.message ?? error) }
    }
  }

  /** Convenience: dispatch a task using a teammate's bound machine. */
  async assign(args, exec) {
    const binding = this.bindings.get(args.member)
    if (binding === undefined) {
      return { ok: false, reason: `no remote teammate named "${args.member}" is bound in this plugin instance` }
    }
    return this.dispatcher.run({
      machine: binding.machine,
      task: args.task,
      wait: args.wait ?? false,
    }, exec)
  }

  list() {
    return [...this.bindings.entries()].map(([name, binding]) => ({ name, ...binding }))
  }
}

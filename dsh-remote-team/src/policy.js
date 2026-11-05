/**
 * Dispatch policy: task validation and per-machine capacity gating.
 *
 * The guard runs inside each tool's execute() by default. Optionally it can
 * also be installed as a `tools/pre-execute` waterfall listener; that listener
 * always calls next() unless it denies, per the DSH waterfall contract.
 */

export const REMOTE_TEAM_TOOL_NAMES = Object.freeze([
  'remote_team_run',
  'remote_team_parallel',
  'remote_team_route',
  'remote_team_cancel',
  'remote_team_status',
  'remote_team_output',
  'remote_team_list',
  'remote_team_probe',
  'spawn_remote_teammate',
  'assign_remote_task',
])

export class DispatchPolicy {
  /** @param {{config: object, registry: object}} deps */
  constructor({ config, registry }) {
    this.config = config
    this.registry = registry
    this.globalActive = 0
  }

  validateTask(task) {
    if (typeof task !== 'string' || task.trim().length === 0) {
      return { ok: false, reason: 'task must be a non-empty string' }
    }
    if (task.length > this.config.maxTaskChars) {
      return { ok: false, reason: `task exceeds maxTaskChars=${this.config.maxTaskChars}` }
    }
    return { ok: true }
  }

  /** Called before a run is started. Returns a release function when admitted. */
  admit(machineId) {
    const task = { ok: true }
    if (!task.ok) return { ok: false, reason: task.reason }
    if (this.globalActive >= this.config.maxParallel) {
      return { ok: false, reason: `global parallel limit ${this.config.maxParallel} reached (DSH maxActiveSubagents defaults to 8)` }
    }
    const releaseMachine = this.registry.acquire(machineId)
    if (releaseMachine === undefined) {
      const row = this.registry.list().find((entry) => entry.id === machineId)
      return { ok: false, reason: `machine "${machineId}" is at its concurrency limit (${row?.maxConcurrentRuns ?? '?'})` }
    }
    this.globalActive += 1
    let released = false
    return {
      ok: true,
      release: () => {
        if (released) return
        released = true
        this.globalActive = Math.max(0, this.globalActive - 1)
        releaseMachine()
      },
    }
  }

  /** Optional waterfall listener. Observers must call next() or they swallow downstream work. */
  preExecuteListener() {
    return async (exec, next) => {
      if (!REMOTE_TEAM_TOOL_NAMES.includes(exec?.name)) return next()
      if (exec.name !== 'remote_team_run' && exec.name !== 'remote_team_parallel') return next()
      const args = exec.arguments ?? {}
      const verdict = this.validateTask(args.task ?? (Array.isArray(args.tasks) ? args.tasks[0]?.task : undefined))
      if (!verdict.ok) return { kind: 'deny', reason: `dsh-remote-team: ${verdict.reason}` }
      return next()
    }
  }
}

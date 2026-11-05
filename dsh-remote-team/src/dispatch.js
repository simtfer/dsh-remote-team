/**
 * Remote task dispatch over ctx.subagents using one Pi provider instance per
 * machine. delivery:'caller' gives us the SubagentResult directly; the stream
 * decoding, cancellation and process cleanup stay owned by subagent-pi.
 */

import { randomUUID } from 'node:crypto'
import { textOfOutput } from './tool.js'
import { safeDiagnostic } from './credentials.js'

const UNKNOWN_CODES = new Set(['OUTCOME_UNKNOWN', 'UNREACHABLE', 'CONNECTION_CLOSED', 'UNAVAILABLE'])

function isUnknownOutcome(error) {
  if (error === null || typeof error !== 'object') return false
  if (UNKNOWN_CODES.has(String(error.code))) return true
  return /outcome unknown|connection closed|socket closed|unreachable/i.test(String(error.message ?? ''))
}

export class RemoteDispatcher {
  /** @param {{ctx: object, config: object, registry: object, store: object, policy: object, logger?: object}} deps */
  constructor({ ctx, config, registry, store, policy, logger }) {
    this.ctx = ctx
    this.config = config
    this.registry = registry
    this.store = store
    this.policy = policy
    this.logger = logger
    this.activations = new Map()
    this.cancelled = new Set()
  }

  /** Start one remote run. Returns a model-safe plain object; never throws on a remote failure. */
  async run(spec, exec) {
    const { task, cwd, wait = false, machine, tags, prefer } = spec
    const taskCheck = this.policy.validateTask(task)
    if (!taskCheck.ok) return { ok: false, reason: taskCheck.reason }
    if (exec?.agent === undefined || exec.agent === null) {
      throw new Error('remote_team_run requires a calling agent (exec.agent was undefined)')
    }

    let route
    try {
      route = this.registry.route({ machine, tags, prefer })
    } catch (error) {
      return { ok: false, reason: String(error.message ?? error) }
    }
    const target = this.registry.get(route.id)
    const admitted = this.policy.admit(route.id)
    if (!admitted.ok) return { ok: false, reason: admitted.reason, machine: route.id }

    const runId = randomUUID()
    const startedAt = new Date().toISOString()
    const workingDirectory = cwd ?? target.cwd
    const signal = exec.signal ?? new AbortController().signal
    this.store.append({
      runId,
      machine: route.id,
      provider: target.provider,
      task: task.slice(0, 200),
      cwd: workingDirectory,
      status: 'dispatched',
      startedAt,
      reasons: route.reasons,
    })

    let activation
    try {
      activation = await this.ctx.subagents.startActivation({
        provider: target.provider,
        label: `remote:${route.id}:${task.slice(0, 60)}`,
        request: {
          prompt: [{ type: 'text', text: task }],
          parent: exec.agent,
          cwd: workingDirectory,
        },
        signal,
        delivery: 'caller',
      })
    } catch (error) {
      admitted.release()
      const record = this.store.update(runId, {
        status: 'failed',
        diagnostic: safeDiagnostic(error),
        finishedAt: new Date().toISOString(),
      })
      this.registry.noteOutcome(route.id, 'failed')
      return { ok: false, runId, machine: route.id, ...this.publicRecord(record) }
    }

    this.activations.set(runId, activation)
    this.store.update(runId, { status: 'streaming', remoteRunId: String(activation.childId ?? '') })

    const settled = this.#settle(runId, route.id, activation, admitted)
    // Keep the promise alive for wait=false without leaking an unhandled rejection.
    settled.catch((error) => this.logger?.warn?.('remote-team: settlement failed: %o', error))

    if (wait === true) {
      const outcome = await settled
      return { ok: outcome.status === 'settled', runId, machine: route.id, reasons: route.reasons, ...outcome }
    }
    return {
      ok: true,
      runId,
      machine: route.id,
      status: 'streaming',
      reasons: route.reasons,
      hint: 'Use remote_team_status / remote_team_output with this runId.',
    }
  }

  /** Resolve activation.result, journal the outcome, and release capacity exactly once. */
  async #settle(runId, machineId, activation, admitted) {
    let outcome
    try {
      const result = await activation.result
      const stopReason = String(result?.stopReason ?? 'completed')
      const status = stopReason === 'completed' ? 'settled' : 'failed'
      outcome = {
        status,
        stopReason,
        output: textOfOutput(result?.output),
        diagnostic: result?.diagnostic === undefined ? undefined : safeDiagnostic(result.diagnostic),
        finishedAt: new Date().toISOString(),
      }
    } catch (error) {
      outcome = {
        status: isUnknownOutcome(error) ? 'unknown' : 'failed',
        stopReason: 'error',
        output: '',
        diagnostic: safeDiagnostic(error),
        finishedAt: new Date().toISOString(),
      }
    }

    // A cancelled run owns its terminal state; settlement must not overwrite it.
    if (this.cancelled.has(runId)) {
      admitted.release()
      this.activations.delete(runId)
      return this.publicRecord(this.store.get(runId))
    }
    const record = this.store.update(runId, outcome)
    this.registry.noteOutcome(machineId, outcome.status === 'unknown' ? 'unknown' : outcome.status === 'settled' ? 'settled' : 'failed')
    admitted.release()
    this.activations.delete(runId)
    try {
      await activation.dispose()
    } catch (error) {
      this.logger?.warn?.('remote-team: activation dispose failed for %s: %o', runId, error)
    }
    return this.publicRecord(record)
  }

  /** Fan out to multiple machines. Per-machine capacity is enforced by run(). */
  async parallel(spec, exec) {
    const tasks = Array.isArray(spec.tasks) ? spec.tasks : []
    if (tasks.length === 0) return { ok: false, reason: 'tasks must be a non-empty array' }
    if (tasks.length > this.config.maxParallel) {
      return { ok: false, reason: `tasks length ${tasks.length} exceeds maxParallel=${this.config.maxParallel}` }
    }
    const startedAt = Date.now()
    const results = await Promise.all(tasks.map(async (item, index) => {
      try {
        const outcome = await this.run({ ...item, wait: spec.wait ?? true }, exec)
        return { index, ...outcome }
      } catch (error) {
        return { index, ok: false, reason: safeDiagnostic(error) }
      }
    }))
    return {
      ok: results.every((row) => row.ok === true),
      results,
      elapsedMs: Date.now() - startedAt,
      byMachine: Object.fromEntries(results.map((row) => [String(row.machine ?? row.index), row.status ?? row.reason ?? 'unknown'])),
    }
  }

  /** Cancel a live run. Unknown outcome is never retried automatically. */
  async cancel(runId) {
    const record = this.store.get(runId)
    if (record === undefined) return { ok: false, reason: `unknown runId "${runId}"` }
    const activation = this.activations.get(runId)
    if (activation === undefined) {
      return { ok: false, reason: `run "${runId}" already settled (${record.status}); nothing to cancel` }
    }
    this.cancelled.add(runId)
    try {
      await activation.dispose()
    } catch (error) {
      this.cancelled.delete(runId)
      return { ok: false, reason: safeDiagnostic(error) }
    }
    const updated = this.store.update(runId, { status: 'cancelled', finishedAt: new Date().toISOString() })
    this.activations.delete(runId)
    return { ok: true, runId, ...this.publicRecord(updated) }
  }

  status(runId) {
    const record = this.store.get(runId)
    if (record === undefined) return { ok: false, reason: `unknown runId "${runId}"` }
    return { ok: true, ...this.publicRecord(record) }
  }

  /**
   * Return the final output with a character cursor. Fine-grained streaming
   * progress is not exposed by SubagentActivation, so only the final text and
   * the terminal status are available here.
   */
  output(runId, cursor = 0) {
    const record = this.store.get(runId)
    if (record === undefined) return { ok: false, reason: `unknown runId "${runId}"` }
    const text = typeof record.output === 'string' ? record.output : ''
    const from = Math.max(0, Math.min(Number(cursor) || 0, text.length))
    return {
      ok: true,
      runId,
      status: record.status,
      text: text.slice(from),
      nextCursor: text.length,
      settled: ['settled', 'failed', 'unknown', 'cancelled'].includes(record.status),
    }
  }

  /** Only fields that are safe and useful to show the model. */
  publicRecord(record) {
    return {
      status: record.status,
      stopReason: record.stopReason,
      output: record.output,
      diagnostic: record.diagnostic,
      remoteRunId: record.remoteRunId,
      startedAt: record.startedAt,
      finishedAt: record.finishedAt,
    }
  }

  /** Dispose every still-live activation when the plugin fiber unloads. */
  async dispose() {
    const pending = [...this.activations.values()]
    this.activations.clear()
    await Promise.all(pending.map(async (activation) => {
      try { await activation.dispose() } catch { /* best effort on teardown */ }
    }))
  }
}

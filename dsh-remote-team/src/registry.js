/**
 * Machine inventory, capability profile, and per-machine routing scores.
 *
 * The static machine list comes from the bundle config; live status/platform
 * comes from ctx.remoteExec.listMachines()/probe(). Routing is deliberately
 * explainable: every decision returns its score breakdown so the model can see
 * why a machine was chosen.
 */

export class MachineRegistry {
  /** @param {{config: object, remoteExec?: object, logger?: object}} deps */
  constructor({ config, remoteExec, logger }) {
    this.config = config
    this.remoteExec = remoteExec
    this.logger = logger
    this.dynamic = new Map()
    this.active = new Map()
    this.history = new Map()
    for (const machine of config.machines) {
      this.active.set(machine.id, 0)
      this.history.set(machine.id, { ok: 0, failed: 0, unknown: 0 })
    }
  }

  /** Merge static config with the latest observed state. */
  list() {
    return this.config.machines.map((machine) => {
      const observed = this.dynamic.get(machine.id) ?? {}
      return {
        id: machine.id,
        name: machine.name,
        platform: observed.platform ?? machine.platform,
        status: observed.status ?? 'unknown',
        tags: [...machine.tags],
        capabilities: [...machine.capabilities],
        cwd: machine.cwd,
        activeRuns: this.active.get(machine.id) ?? 0,
        maxConcurrentRuns: machine.maxConcurrentRuns,
        ...(observed.probedAt !== undefined ? { probedAt: observed.probedAt } : {}),
        ...(observed.error !== undefined ? { error: observed.error } : {}),
      }
    })
  }

  get(id) {
    return this.config.machines.find((machine) => machine.id === id)
  }

  /** Refresh status from ctx.remoteExec. Never throws: an offline machine is data, not an error. */
  async refresh(signal) {
    if (this.remoteExec?.listMachines === undefined) return this.list()
    let observed = []
    try {
      observed = this.remoteExec.listMachines() ?? []
    } catch (error) {
      this.logger?.warn?.('remote-team: listMachines failed: %o', error)
      return this.list()
    }
    for (const row of observed) {
      if (row?.id === undefined) continue
      this.dynamic.set(String(row.id), {
        status: row.status ?? 'unknown',
        platform: row.platform,
      })
    }
    if (this.remoteExec.probe !== undefined) {
      await Promise.all(this.config.machines.map(async (machine) => {
        try {
          const row = await this.remoteExec.probe(machine.id, signal)
          this.dynamic.set(machine.id, {
            status: row?.status ?? 'online',
            platform: row?.platform ?? machine.platform,
            probedAt: new Date().toISOString(),
          })
        } catch (error) {
          this.dynamic.set(machine.id, {
            status: 'offline',
            platform: machine.platform,
            probedAt: new Date().toISOString(),
            error: String(error?.code ?? error?.message ?? error),
          })
        }
      }))
    }
    return this.list()
  }

  /** Score and choose a machine. Explicit machine always wins (decision #5). */
  route({ machine, tags, prefer } = {}) {
    if (machine !== undefined) {
      const chosen = this.get(machine)
      if (chosen === undefined) {
        throw new Error(`unknown machine "${machine}". Use remote_team_list to see configured ids.`)
      }
      return { id: chosen.id, reasons: ['explicit machine'], scores: [{ id: chosen.id, score: null }] }
    }
    const wanted = new Set(tags ?? [])
    const scores = this.list().map((row) => {
      const staticMachine = this.get(row.id)
      const reasons = []
      let score = 0
      if (row.status === 'online') { score += 50; reasons.push('online +50') }
      else if (row.status === 'unknown') { score += 10; reasons.push('unknown +10') }
      else { score -= 1000; reasons.push('offline -1000') }

      const matched = [...wanted].filter((tag) => row.tags.includes(tag))
      if (matched.length > 0) { score += matched.length * 20; reasons.push(`tags(${matched.join(',')}) +${matched.length * 20}`) }
      else if (wanted.size > 0) { score -= 10; reasons.push('tag mismatch -10') }

      const free = Math.max(0, row.maxConcurrentRuns - row.activeRuns)
      const ratio = free / row.maxConcurrentRuns
      score += Math.round(ratio * 30)
      reasons.push(`capacity ${free}/${row.maxConcurrentRuns} +${Math.round(ratio * 30)}`)

      const history = this.history.get(row.id) ?? { ok: 0, failed: 0, unknown: 0 }
      const total = history.ok + history.failed + history.unknown
      if (total > 0) {
        const reliability = Math.round((history.ok / total) * 20)
        score += reliability
        reasons.push(`success rate ${history.ok}/${total} +${reliability}`)
      }
      if (prefer !== undefined && (prefer === row.id || row.tags.includes(prefer))) {
        score += 100
        reasons.push(`prefer(${prefer}) +100`)
      }
      if (staticMachine.capabilities.length > 0) reasons.push(`capabilities(${staticMachine.capabilities.join(',')})`)
      return { id: row.id, score, reasons }
    })
    scores.sort((a, b) => b.score - a.score)
    const best = scores[0]
    if (best === undefined || best.score < 0) {
      throw new Error('no remote machine is currently usable. Run remote_team_probe or pick a machine explicitly.')
    }
    return { id: best.id, reasons: best.reasons, scores: scores.map(({ id, score }) => ({ id, score })) }
  }

  /** Acquire one capacity slot. Returns a release function, or undefined when full. */
  acquire(id) {
    const machine = this.get(id)
    if (machine === undefined) return undefined
    const current = this.active.get(id) ?? 0
    if (current >= machine.maxConcurrentRuns) return undefined
    this.active.set(id, current + 1)
    return () => this.release(id)
  }

  release(id) {
    this.active.set(id, Math.max(0, (this.active.get(id) ?? 1) - 1))
  }

  noteOutcome(id, kind) {
    const row = this.history.get(id) ?? { ok: 0, failed: 0, unknown: 0 }
    if (kind === 'settled') row.ok += 1
    else if (kind === 'unknown') row.unknown += 1
    else row.failed += 1
    this.history.set(id, row)
  }
}

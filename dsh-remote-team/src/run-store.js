/**
 * Append-only run journal. ctx.jobs is in-process and disappears on restart,
 * so the plugin keeps its own queryable history. It never resumes runs.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname } from 'node:path'

export class RunStore {
  /** @param {string} filePath - ':memory:' disables disk persistence (tests). */
  constructor(filePath = ':memory:') {
    this.filePath = filePath
    this.records = new Map()
    if (filePath !== ':memory:' && existsSync(filePath)) {
      const text = readFileSync(filePath, 'utf8')
      for (const line of text.split(/\r?\n/)) {
        if (line.trim() === '') continue
        try {
          const record = JSON.parse(line)
          if (record?.runId !== undefined) this.records.set(record.runId, record)
        } catch {
          // A torn last line is tolerable: the journal is diagnostic, not authoritative.
        }
      }
    }
  }

  /** Write one full snapshot of a run. */
  append(record) {
    const snapshot = { ...record, updatedAt: new Date().toISOString() }
    this.records.set(snapshot.runId, snapshot)
    if (this.filePath !== ':memory:') {
      mkdirSync(dirname(this.filePath), { recursive: true })
      appendFileSync(this.filePath, `${JSON.stringify(snapshot)}\n`, 'utf8')
    }
    return snapshot
  }

  /** Merge a patch into the latest snapshot and append it. */
  update(runId, patch) {
    const previous = this.records.get(runId)
    if (previous === undefined) throw new Error(`unknown runId "${runId}"`)
    return this.append({ ...previous, ...patch, runId })
  }

  get(runId) {
    return this.records.get(runId)
  }

  list({ machine, limit = 50 } = {}) {
    const rows = [...this.records.values()]
      .filter((row) => machine === undefined || row.machine === machine)
      .sort((a, b) => String(b.startedAt ?? '').localeCompare(String(a.startedAt ?? '')))
    return rows.slice(0, limit)
  }
}

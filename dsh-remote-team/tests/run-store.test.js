import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RunStore } from '../src/run-store.js'

test('append, update, get and list in memory', () => {
  const store = new RunStore(':memory:')
  store.append({ runId: 'r1', machine: 'dev-win', status: 'dispatched', startedAt: '2026-01-01T00:00:00Z' })
  assert.equal(store.get('r1').status, 'dispatched')
  store.update('r1', { status: 'settled', output: 'PONG' })
  assert.equal(store.get('r1').status, 'settled')
  assert.equal(store.get('r1').output, 'PONG')
  assert.throws(() => store.update('missing', { status: 'x' }), /unknown runId/)
  assert.equal(store.list({ machine: 'build-win' }).length, 0)
  assert.equal(store.list().length, 1)
})

test('survives a restart by replaying the append-only journal', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-remote-team-store-'))
  const file = join(dir, 'runs.jsonl')
  try {
    const first = new RunStore(file)
    first.append({ runId: 'r1', machine: 'dev-win', status: 'dispatched' })
    first.update('r1', { status: 'unknown', diagnostic: 'connection closed' })

    const second = new RunStore(file)
    const record = second.get('r1')
    assert.equal(record.status, 'unknown')
    assert.equal(record.diagnostic, 'connection closed')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

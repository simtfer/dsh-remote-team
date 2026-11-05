/**
 * Configuration normalization and validation.
 *
 * Kept dependency-free on purpose: a third-party DSH bundle receives everything
 * it needs through the injected Cordis context, so importing any DSH package at
 * module load time would make the plugin unloadable from a standalone profile.
 */

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1'])

function fail(message) {
  throw new Error(`dsh-remote-team: ${message}`)
}

function assert(condition, message) {
  if (!condition) fail(message)
}

/** Accept Windows drive paths, UNC paths, and POSIX absolute paths. */
function isAbsolutePath(value) {
  return /^[A-Za-z]:[\\/]/.test(value) || value.startsWith('/') || value.startsWith('\\\\')
}

/**
 * Only loopback endpoints may use plaintext ws://. Everything else must be
 * wss://, because the remote-agent token and all task output cross this link.
 */
export function validateMachineUrl(url, id) {
  let parsed
  try {
    parsed = new URL(url)
  } catch {
    fail(`machine "${id}" has an invalid url "${url}"`)
  }
  if (parsed.protocol === 'wss:') return 'wss'
  if (parsed.protocol === 'ws:') {
    const host = parsed.hostname.replace(/^\[|\]$/g, '').toLowerCase()
    if (LOOPBACK_HOSTS.has(host)) return 'ws-loopback'
    fail(
      `machine "${id}" uses plaintext ws:// on a non-loopback host "${parsed.hostname}". `
      + 'Put the plugin wss-proxy in front of dsh-remote-agent, or use a WireGuard/Tailscale address.',
    )
  }
  fail(`machine "${id}" url must use ws:// or wss://, got "${parsed.protocol}"`)
}

/** Validate and freeze the deployment-owned configuration. */
export function normalizeConfig(raw) {
  assert(raw !== null && typeof raw === 'object' && !Array.isArray(raw), 'config must be an object')
  assert(Array.isArray(raw.machines) && raw.machines.length > 0, 'config.machines must be a non-empty array')

  const ids = new Set()
  const machines = raw.machines.map((machine) => {
    assert(machine !== null && typeof machine === 'object', 'each machine must be an object')
    const { id, provider, cwd } = machine
    assert(typeof id === 'string' && id.trim().length > 0, 'machine.id must be a non-empty string')
    assert(!ids.has(id), `machine id "${id}" is configured twice`)
    ids.add(id)
    assert(typeof provider === 'string' && provider.trim().length > 0, `machine "${id}" needs a provider name`)
    assert(typeof cwd === 'string' && isAbsolutePath(cwd), `machine "${id}" cwd must be an absolute path on the remote machine`)

    const url = typeof machine.url === 'string' ? machine.url : undefined
    if (url !== undefined) validateMachineUrl(url, id)

    const maxConcurrentRuns = machine.maxConcurrentRuns ?? 2
    assert(Number.isInteger(maxConcurrentRuns) && maxConcurrentRuns >= 1, `machine "${id}" maxConcurrentRuns must be a positive integer`)

    const tags = machine.tags ?? []
    assert(Array.isArray(tags) && tags.every((tag) => typeof tag === 'string'), `machine "${id}" tags must be an array of strings`)

    return Object.freeze({
      id,
      name: machine.name ?? id,
      provider,
      cwd,
      url,
      tags: Object.freeze([...tags]),
      maxConcurrentRuns,
      platform: machine.platform ?? 'windows',
      capabilities: Object.freeze([...(machine.capabilities ?? [])]),
    })
  })

  const maxParallel = raw.maxParallel ?? 4
  assert(Number.isInteger(maxParallel) && maxParallel >= 1 && maxParallel <= 8, 'config.maxParallel must be between 1 and 8 (DSH maxActiveSubagents defaults to 8)')

  return Object.freeze({
    machines: Object.freeze(machines),
    teamProvider: raw.teamProvider ?? 'spawn',
    maxParallel,
    maxTaskChars: raw.maxTaskChars ?? 200_000,
    runStorePath: raw.runStorePath ?? undefined,
    enablePreExecuteGuard: raw.enablePreExecuteGuard === true,
    workerPreset: raw.workerPreset ?? undefined,
  })
}

/** Resolve the append-only run log location. */
export function resolveRunStorePath(explicit) {
  if (explicit) return explicit
  const home = process.env.DSH_HOME
  const base = home ?? `${process.env.USERPROFILE ?? process.env.HOME ?? '.'}/.dsh`
  return `${base.replace(/[\\/]+$/, '')}/remote-team/runs.jsonl`
}

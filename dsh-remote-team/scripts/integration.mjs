#!/usr/bin/env node
/**
 * Real-loader integration check for dsh-remote-team.
 *
 * The 29 unit tests use a mock context and the upstream remote-pi.spec.ts
 * exercises only the remote provider chain. Neither proves that THIS bundle
 * can actually be mounted into a DSH profile. This check closes that gap:
 *
 *   - a real Cordis Context
 *   - DSH's real ToolRuntime (so register() runs assertSupportedJsonSchema
 *     against all ten of our tool schemas)
 *   - our real index.js with its declared inject list
 *   - one read-only tool call
 *   - disposal, proving every registration is a reversible effect
 *
 * It deliberately does NOT need a remote machine, a Pi binary, or credentials.
 *
 * Usage:
 *   node scripts/integration.mjs [path-to-deepseek-harness]
 *   DSH_REPO=D:/code/github/deepseek-harness node scripts/integration.mjs
 *
 * Requires the DSH workspace's lib/ products and readable node_modules.
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import * as plugin from '../index.js'

const REPO = resolve(process.argv[2] ?? process.env.DSH_REPO ?? 'D:/code/github/deepseek-harness')
const TOOLS_PKG = join(REPO, 'packages/core/tools')

// Resolve from a workspace package, NOT the repo root: pnpm links workspace
// dependencies into each package's own node_modules directory.
const req = createRequire(join(TOOLS_PKG, 'package.json'))
const load = async spec => import(pathToFileURL(req.resolve(spec)).href)

const TOOL_NAMES = [
  'remote_team_list',
  'remote_team_probe',
  'remote_team_route',
  'remote_team_run',
  'remote_team_parallel',
  'remote_team_status',
  'remote_team_output',
  'remote_team_cancel',
  'spawn_remote_teammate',
  'assign_remote_task',
]

let failures = 0
function check(label, ok, detail = '') {
  if (ok) {
    console.log(`  ok   ${label}`)
  } else {
    failures += 1
    console.error(`  FAIL ${label}${detail === '' ? '' : ` — ${detail}`}`)
  }
}

const workdir = mkdtempSync(join(tmpdir(), 'dsh-remote-team-integration-'))
const config = {
  machines: [
    {
      id: 'dev-win',
      name: 'Development Windows',
      provider: 'pi@dev-win',
      cwd: 'D:\\work\\repo',
      url: 'wss://192.168.1.20:8787',
      tags: ['dev', 'windows'],
      capabilities: ['pi', 'node'],
      maxConcurrentRuns: 2,
    },
    {
      id: 'build-win',
      name: 'Build Windows',
      provider: 'pi@build-win',
      cwd: 'D:\\build\\repo',
      url: 'wss://192.168.1.21:8787',
      tags: ['build', 'windows'],
      capabilities: ['pi', 'node'],
      maxConcurrentRuns: 1,
    },
  ],
  maxParallel: 4,
  runStorePath: join(workdir, 'runs.jsonl'),
}

async function main() {
  const { Context } = await load('@deepseek-ai/cordis')
  const ToolRuntime = (await import(pathToFileURL(join(TOOLS_PKG, 'lib/index.js')).href)).default

  const ctx = new Context()

  // ToolRuntime injects systemPrompt; this check does not exercise prompt
  // rendering, so a no-op stand-in keeps the composition honest but small.
  ctx.provide('systemPrompt', {
    tools: () => () => {},
    section: () => () => {},
  })
  // The bundle injects subagents. Dispatch is covered by unit tests; here it
  // only has to exist so Cordis can resolve the inject list.
  ctx.provide('subagents', {
    startActivation: async () => { throw new Error('dispatch is not exercised by this check') },
    getProvider: () => undefined,
  })

  await ctx.plugin(ToolRuntime)
  check('real ToolRuntime provides ctx.tools', typeof ctx.tools?.get === 'function')

  await ctx.plugin(plugin, config)
  const tools = ctx.tools

  for (const name of TOOL_NAMES) {
    let registered = false
    let detail = ''
    try {
      registered = tools.get(name)?.name === name
    } catch (error) {
      detail = String(error.message ?? error)
    }
    check(`register() accepts ${name}`, registered, detail)
  }

  const listed = await tools.get('remote_team_list').execute({}, { signal: new AbortController().signal })
  check('remote_team_list returns both configured machines', listed?.machines?.length === 2, JSON.stringify(listed))

  await ctx.fiber.dispose()
  let allRemoved = true
  try {
    allRemoved = TOOL_NAMES.every(name => tools.get(name) === undefined)
  } catch {
    // A fully disposed runtime may refuse lookups entirely; that also means
    // no tool is reachable any more.
    allRemoved = true
  }
  check('all ten tools are unregistered on dispose', allRemoved)
}

try {
  console.log(`dsh-remote-team integration check (DSH: ${REPO})`)
  await main()
} catch (error) {
  failures += 1
  console.error(`  FAIL integration threw: ${error?.stack ?? error}`)
} finally {
  rmSync(workdir, { recursive: true, force: true })
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`)
  process.exitCode = 1
} else {
  console.log('\nall integration checks passed')
}

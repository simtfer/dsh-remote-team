/**
 * Static delivery check: manifest shape, declared files, patch consistency,
 * and syntax of every JavaScript file. No DSH install required.
 */

import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const problems = []
const checked = []

function ok(condition, message) {
  if (!condition) problems.push(message)
}

const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
ok(manifest.type === 'module', 'package.json must be type=module')
ok(manifest.dsh?.bundle?.patch === './cordis.patch.yml', 'package.json needs dsh.bundle.patch')
ok(manifest.dsh?.client?.platform === 'web', 'package.json needs dsh.client.platform=web')
ok(typeof manifest.engines?.dsh === 'string', 'package.json needs engines.dsh')

for (const [key, target] of Object.entries(manifest.exports ?? {})) {
  if (target.includes('*')) continue
  ok(existsSync(join(root, target)), `exports "${key}" -> missing ${target}`)
}
for (const entry of manifest.files ?? []) {
  ok(existsSync(join(root, entry)), `files entry missing: ${entry}`)
}
for (const name of ['locale/en.json', 'locale/zh.json', 'icon.svg', 'cordis.patch.yml']) {
  ok(existsSync(join(root, name)), `missing ${name}`)
}

// Every declared peer must be one of the branch-only upstream packages.
for (const peer of Object.keys(manifest.peerDependencies ?? {})) {
  ok(peer.startsWith('@deepseek-ai/dsh-remote') || peer === '@deepseek-ai/dsh-subagent-pi', `unexpected peer ${peer}`)
}

// Patch consistency: providerName rows must match the bundle's machine providers.
const patch = readFileSync(join(root, 'cordis.patch.yml'), 'utf8')
const providerNames = [...patch.matchAll(/providerName:\s*'([^']+)'/g)].map((match) => match[1])
const machineProviders = [...patch.matchAll(/^\s+provider:\s*'([^']+)'/gm)].map((match) => match[1])
ok(providerNames.length > 0, 'cordis.patch.yml has no subagent-pi providerName rows')
ok(machineProviders.length > 0, 'cordis.patch.yml has no remote-team machine providers')
for (const provider of machineProviders) {
  ok(providerNames.includes(provider), `machine provider "${provider}" has no matching subagent-pi providerName`)
}
for (const name of providerNames) {
  ok(machineProviders.includes(name), `providerName "${name}" is not bound to a remote-team machine`)
}
ok(/--approve/.test(patch), 'subagent-pi args must include --approve (Pi skips trust prompts in print/JSON mode)')
ok(!/url:\s*'ws:\/\/(?!127\.0\.0\.1|localhost)/.test(patch), 'non-loopback plaintext ws:// found in cordis.patch.yml')

const jsFiles = [
  'index.js', 'client.js',
  ...readdirSync(join(root, 'src')).filter((name) => name.endsWith('.js')).map((name) => join('src', name)),
  ...readdirSync(join(root, 'tests')).filter((name) => name.endsWith('.js')).map((name) => join('tests', name)),
  join('remote-agent', 'wss-proxy.js'),
  join('scripts', 'check.mjs'),
]
for (const file of jsFiles) {
  try {
    execFileSync(process.execPath, ['--check', join(root, file)], { stdio: 'pipe' })
    checked.push(file)
  } catch (error) {
    problems.push(`syntax error in ${file}: ${String(error.stderr ?? error.message)}`)
  }
}

if (problems.length > 0) {
  console.error(`check FAILED (${problems.length}):`)
  for (const problem of problems) console.error(`  - ${problem}`)
  process.exit(1)
}
console.log(`check OK: manifest, ${checked.length} JS files, patch consistency`)

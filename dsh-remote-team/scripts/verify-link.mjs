/**
 * Verify one dsh-remote-agent endpoint with the real WebSocket protocol.
 *
 * Zero dependencies: uses only the Node 22+ global WebSocket and node: builtins.
 * The agent must already be running; this script never starts one.
 *
 * Usage:
 *   node scripts/verify-link.mjs --url wss://dev-win:8787 --token "$TOKEN" \
 *     --command pi --args=--version --cwd 'D:\work\repo'
 *
 * Environment fallbacks: DSH_REMOTE_URL, DSH_REMOTE_TOKEN,
 * DSH_REMOTE_COMMAND, DSH_REMOTE_ARGS, DSH_REMOTE_CWD.
 * `--args` is comma-separated so Windows paths stay intact on Git Bash.
 */

import { setTimeout as delay } from 'node:timers/promises'

function parseArgs(argv) {
  const options = {}
  for (let i = 0; i < argv.length; i++) {
    const item = argv[i]
    if (!item.startsWith('--')) continue
    const eq = item.indexOf('=')
    let key, value
    if (eq !== -1) {
      key = item.slice(2, eq)
      value = item.slice(eq + 1)
    } else {
      key = item.slice(2)
      const next = argv[i + 1]
      if (next !== undefined && !next.startsWith('--')) {
        value = next
        i++
      } else value = 'true'
    }
    if (key === 'args') (options.args ??= []).push(...value.split(',').filter(Boolean))
    else options[key] = value
  }
  return options
}

const cli = parseArgs(process.argv.slice(2))
const url = cli.url ?? process.env.DSH_REMOTE_URL ?? 'ws://127.0.0.1:8787'
const token = cli.token ?? process.env.DSH_REMOTE_TOKEN
const command = cli.command ?? process.env.DSH_REMOTE_COMMAND ?? 'pi'
const args = cli.args ?? (process.env.DSH_REMOTE_ARGS ?? '--version').split(',').filter(Boolean)
const cwd = cli.cwd ?? process.env.DSH_REMOTE_CWD ?? process.cwd()

// Plain ws:// is only acceptable on loopback; production links must use wss.
const parsed = new URL(url)
const loopback = parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost' || parsed.hostname === '[::1]'
if (parsed.protocol === 'ws:' && !loopback) {
  console.error('REFUSED: non-loopback ws:// is not allowed; use wss://')
  process.exit(2)
}
if (!token) {
  console.error('REFUSED: --token or DSH_REMOTE_TOKEN is required')
  process.exit(2)
}

const frames = []
let ws
for (let i = 0; i < 20; i++) {
  const candidate = new WebSocket(url)
  const connected = await Promise.race([
    new Promise(resolve => {
      candidate.addEventListener('open', () => resolve(true), { once: true })
      candidate.addEventListener('error', () => resolve(false), { once: true })
    }),
    delay(2000).then(() => false),
  ])
  if (connected) { ws = candidate; break }
  try { candidate.close() } catch { /* still handshaking */ }
  await delay(250)
}
if (!ws) {
  console.error('AGENT UNREACHABLE:', url)
  process.exit(1)
}

let settle
const settled = new Promise(resolve => { settle = resolve })
ws.addEventListener('message', event => {
  const frame = JSON.parse(event.data)
  frames.push(frame)
  if (frame.type === 'welcome') {
    ws.send(JSON.stringify({
      type: 'spawn', id: 'verify', command, args, cwd,
      captureStdout: true, captureStderr: true,
    }))
  } else if (frame.type === 'exit' || frame.type === 'rejected') {
    settle(frame)
  }
})
ws.addEventListener('error', () => settle({ type: 'error' }))
// The retry loop above already waited for `open`; send hello immediately.
ws.send(JSON.stringify({ type: 'hello', version: 1, token }))

let final
try {
  final = await Promise.race([
    settled,
    delay(15000).then(() => ({ type: 'timeout' })),
  ])
} catch (error) {
  console.error('VERIFY FAILED:', error.message)
  ws.close()
  process.exit(1)
}

const decode = kind => frames
  .filter(frame => frame.type === kind && frame.id === 'verify')
  .map(frame => Buffer.from(frame.data, 'base64').toString('utf8'))
  .join('')

const welcome = frames.find(frame => frame.type === 'welcome')
console.log('url      :', url)
console.log('welcome  :', JSON.stringify(welcome))
console.log('started  :', JSON.stringify(frames.find(frame => frame.type === 'started')))
console.log('rejected :', JSON.stringify(frames.find(frame => frame.type === 'rejected')))
console.log('stdout   :', JSON.stringify(decode('stdout').trim()))
console.log('stderr   :', JSON.stringify(decode('stderr').trim()))
console.log('final    :', JSON.stringify(final))

ws.close()
const ok = welcome?.platform !== undefined
  && final.type === 'exit'
  && final.code === 0
console.log('LINK OK  :', ok)
process.exit(ok ? 0 : 1)

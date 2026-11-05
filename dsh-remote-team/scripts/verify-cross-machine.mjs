/**
 * Development-only cross-machine verification through a reverse TCP tunnel.
 *
 * Why: a fresh Windows guest usually blocks inbound TCP (firewall enabled), and
 * adding an allow rule needs elevation. The guest can still dial OUT to the
 * host, so a reverse tunnel lets a host-side WebSocket client drive the real
 * dsh-remote-agent inside the VM without touching the guest firewall.
 * This is NOT the production path: production uses install.ps1 + wss://.
 *
 * Prerequisites:
 *   - VirtualBox guest additions running, guest logged in / guestcontrol usable
 *   - dsh-remote-agent already running inside the guest on 127.0.0.1:<port>,
 *     started with an allowlist containing `node` and `hostname`
 *   - Node inside the guest (the portable zip layout works fine)
 *
 * No credential is stored in this file. Use DSH_VM_PASSWORD_FILE when possible.
 *
 * Usage:
 *   DSH_VM_PASSWORD_FILE=/path/to/pw DSH_REMOTE_TOKEN=... \
 *   DSH_VM_NODE='C:\dsh\node-v22.22.2-win-x64\node.exe' \
 *   node scripts/verify-cross-machine.mjs
 */

import net from 'node:net'
import os from 'node:os'
import { execFileSync } from 'node:child_process'
import { setTimeout as delay } from 'node:timers/promises'

const env = process.env
const VBM = env.DSH_VBOXMANAGE ?? 'C:/Program Files/Oracle/VirtualBox/VBoxManage.exe'
const VM = env.DSH_VM_NAME ?? 'Win11-Test'
const USER = env.DSH_VM_USER ?? 'testuser'
const GUEST_NODE = env.DSH_VM_NODE
const TOKEN = env.DSH_REMOTE_TOKEN
const CWD = env.DSH_VM_CWD ?? 'C:\\dsh'
const AGENT_PORT = Number(env.DSH_VM_AGENT_PORT ?? 8787)
const TUNNEL_PORT = Number(env.DSH_VM_TUNNEL_PORT ?? 9900)
const CLIENT_PORT = Number(env.DSH_VM_CLIENT_PORT ?? 8788)
const GUEST_TARGET = env.DSH_VM_TARGET ?? '10.0.2.2'
const TUNNELS = 4

const auth = [`--username=${USER}`]
if (env.DSH_VM_PASSWORD_FILE) auth.push(`--passwordfile=${env.DSH_VM_PASSWORD_FILE}`)
else if (env.DSH_VM_PASSWORD) auth.push(`--password=${env.DSH_VM_PASSWORD}`)
else {
  console.error('REFUSED: set DSH_VM_PASSWORD_FILE (preferred) or DSH_VM_PASSWORD')
  process.exit(2)
}
for (const [name, value] of [['DSH_VM_NODE', GUEST_NODE], ['DSH_REMOTE_TOKEN', TOKEN]]) {
  if (!value) { console.error(`REFUSED: ${name} is required`); process.exit(2) }
}

/** Host relay: pool of guest-dialed tunnels + a local WebSocket endpoint. */
const tunnels = []
const tunnelServer = net.createServer(socket => {
  tunnels.push(socket)
  socket.on('close', () => {
    const i = tunnels.indexOf(socket)
    if (i >= 0) tunnels.splice(i, 1)
  })
})
const clientServer = net.createServer(client => {
  const tunnel = tunnels.shift()
  if (!tunnel || tunnel.destroyed) { client.destroy(); return }
  client.pipe(tunnel)
  tunnel.pipe(client)
  client.on('close', () => tunnel.destroy())
  tunnel.on('close', () => client.destroy())
})
await Promise.all([
  new Promise(resolve => tunnelServer.listen(TUNNEL_PORT, '0.0.0.0', resolve)),
  new Promise(resolve => clientServer.listen(CLIENT_PORT, '127.0.0.1', resolve)),
])
console.log(`HOST: relay listening (tunnel :${TUNNEL_PORT}, client :${CLIENT_PORT})`)

/** Guest relay client: dial out to the host and bridge to the local agent. */
const relayCode = `
const net=require('net');
function tunnel(){
  const up=net.connect(${TUNNEL_PORT},${JSON.stringify(GUEST_TARGET)});
  const local=net.connect(${AGENT_PORT},'127.0.0.1');
  let closed=false;
  const close=()=>{if(closed)return;closed=true;up.destroy();local.destroy()};
  up.on('error',close);local.on('error',close);
  up.on('close',close);local.on('close',close);
  up.pipe(local);local.pipe(up);
}
for(let i=0;i<${TUNNELS};i++)tunnel();
`
try {
  execFileSync(VBM, [
    'guestcontrol', VM, 'start', ...auth,
    `--exe=${GUEST_NODE}`, '--', '-e', relayCode,
  ], { encoding: 'utf8', timeout: 30000 })
  console.log('HOST: guest relay-client started')
} catch (error) {
  console.error('HOST: relay-client start failed:', String(error.message).slice(0, 300))
  process.exit(1)
}

for (let i = 0; i < 40 && tunnels.length === 0; i++) await delay(250)
console.log('HOST: available tunnels =', tunnels.length)
if (tunnels.length === 0) { console.error('NO TUNNEL'); process.exit(1) }

/** Drive one real command through the tunnel with the agent protocol. */
async function runCommand(label, command, args) {
  const frames = []
  let ws
  try { ws = new WebSocket(`ws://127.0.0.1:${CLIENT_PORT}`) } catch (error) {
    return { label, error: String(error) }
  }
  let settle
  const settled = new Promise(resolve => { settle = resolve })
  ws.addEventListener('message', event => {
    const frame = JSON.parse(event.data)
    frames.push(frame)
    if (frame.type === 'welcome') {
      ws.send(JSON.stringify({
        type: 'spawn', id: 'verify', command, args, cwd: CWD,
        captureStdout: true, captureStderr: true,
      }))
    } else if (frame.type === 'exit' || frame.type === 'rejected') {
      settle(frame)
    }
  })
  ws.addEventListener('error', () => settle({ type: 'error' }))
  ws.addEventListener('open', () => {
    ws.send(JSON.stringify({ type: 'hello', version: 1, token: TOKEN }))
  }, { once: true })
  const final = await Promise.race([
    settled,
    delay(12000).then(() => ({ type: 'timeout' })),
  ])
  ws.close()
  const stdout = frames
    .filter(frame => frame.type === 'stdout' && frame.id === 'verify')
    .map(frame => Buffer.from(frame.data, 'base64').toString('utf8'))
    .join('').trim()
  return {
    label,
    platform: frames.find(frame => frame.type === 'welcome')?.platform,
    stdout,
    final,
  }
}

const results = []
results.push(await runCommand('node -v', GUEST_NODE, ['-v']))
results.push(await runCommand('hostname', 'C:\\Windows\\System32\\hostname.exe', []))
results.push(await runCommand(
  'platform probe',
  GUEST_NODE,
  ['-e', "console.log(process.platform + '|' + process.arch + '|' + require('os').hostname())"],
))

console.log('\n=== CROSS-MACHINE RESULTS ===')
for (const result of results) console.log(JSON.stringify(result))
console.log('host hostname =', os.hostname())

const ok = results.every(result =>
  result.platform === 'windows'
  && result.final?.type === 'exit'
  && result.final.code === 0)
const distinctHost = results[1]?.stdout
  && results[1].stdout.toLowerCase() !== os.hostname().toLowerCase()
console.log('ALL COMMANDS OK =', ok)
console.log('EXECUTED ON GUEST (hostname differs) =', Boolean(distinctHost))

for (const socket of tunnels) socket.destroy()
tunnelServer.close()
clientServer.close()
process.exit(ok && distinctHost ? 0 : 1)

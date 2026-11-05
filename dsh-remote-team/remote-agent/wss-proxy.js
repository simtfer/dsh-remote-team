#!/usr/bin/env node
/**
 * TLS terminator for dsh-remote-agent.
 *
 * dsh-remote-agent uses ws's WebSocketServer({port, host}) over plain HTTP and
 * has no TLS support. This proxy exposes wss:// on the network and forwards
 * frames verbatim to a loopback-only agent, so control hosts can use Node's
 * global WebSocket with NODE_EXTRA_CA_CERTS without changing upstream code.
 *
 * Requires the `ws` package (already a dependency of dsh-remote-agent):
 *   npm install ws@8
 */

import { readFileSync } from 'node:fs'
import { createServer } from 'node:https'
import { parseArgs } from 'node:util'

const { values } = parseArgs({
  options: {
    host: { type: 'string', default: '0.0.0.0' },
    port: { type: 'string', default: '8787' },
    cert: { type: 'string' },
    key: { type: 'string' },
    target: { type: 'string', default: 'ws://127.0.0.1:8788' },
    help: { type: 'boolean', default: false },
  },
  strict: true,
})

if (values.help) {
  console.log('usage: node wss-proxy.js --cert <server.pem> --key <server.key> [--host 0.0.0.0] [--port 8787] [--target ws://127.0.0.1:8788]')
  process.exit(0)
}

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1', '0:0:0:0:0:0:0:1'])
if (!LOOPBACK.has(values.host) && (values.cert === undefined || values.key === undefined)) {
  console.error('refusing to listen on a non-loopback interface without --cert/--key (token and output would be plaintext)')
  process.exit(1)
}

let WebSocket
let WebSocketServer
try {
  const ws = await import('ws')
  WebSocket = ws.WebSocket
  WebSocketServer = ws.WebSocketServer
} catch {
  console.error('the "ws" package is required: run `npm install ws@8` in this directory')
  process.exit(1)
}

const httpsOptions = values.cert === undefined
  ? undefined
  : { cert: readFileSync(values.cert), key: readFileSync(values.key) }

const server = httpsOptions === undefined
  ? null
  : createServer(httpsOptions, (_req, res) => {
    res.writeHead(426, { 'Content-Type': 'text/plain' })
    res.end('WebSocket upgrade required\n')
  })

const wss = new WebSocketServer(server === null ? { port: Number(values.port), host: values.host } : { server })

wss.on('connection', (client, request) => {
  const upstream = new WebSocket(values.target)
  const pending = []
  let upstreamReady = false
  let closed = false

  const closeBoth = () => {
    if (closed) return
    closed = true
    try { client.close() } catch { /* already closed */ }
    try { upstream.close() } catch { /* already closed */ }
  }

  client.on('message', (data, isBinary) => {
    if (upstreamReady && upstream.readyState === WebSocket.OPEN) {
      upstream.send(data, { binary: isBinary })
    } else {
      pending.push({ data, isBinary })
    }
  })
  client.on('close', closeBoth)
  client.on('error', closeBoth)

  upstream.on('open', () => {
    upstreamReady = true
    for (const frame of pending) upstream.send(frame.data, { binary: frame.isBinary })
    pending.length = 0
  })
  upstream.on('message', (data, isBinary) => {
    if (client.readyState === WebSocket.OPEN) client.send(data, { binary: isBinary })
  })
  upstream.on('close', closeBoth)
  upstream.on('error', (error) => {
    console.error(`upstream ${values.target}: ${error.message}`)
    closeBoth()
  })

  console.log(`connection from ${request.socket.remoteAddress} -> ${values.target}`)
})

wss.on('error', (error) => {
  console.error(`wss-proxy: ${error.message}`)
  process.exitCode = 1
})

if (server !== null) {
  server.listen(Number(values.port), values.host, () => {
    console.log(`wss-proxy listening on wss://${values.host}:${values.port} -> ${values.target}`)
  })
} else {
  console.log(`wss-proxy listening on ws://${values.host}:${values.port} (loopback only) -> ${values.target}`)
}

const shutdown = () => {
  wss.close()
  server?.close()
  process.exit(0)
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)

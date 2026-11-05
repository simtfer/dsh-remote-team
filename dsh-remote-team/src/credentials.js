/**
 * Secret reference resolution. Tokens belong in the profile's environment or
 * ctx.credentials, never in cordis.yml or the run journal.
 */

import { optionalService } from './services.js'

const ENV_REF = /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/
const SECRET_REF = /^secret:(.+)$/

/**
 * Resolve a deployment-provided reference.
 * - "${NAME}" reads process.env.NAME.
 * - "secret:name" asks ctx.credentials.resolve(name) when that service exists.
 * - anything else is returned unchanged (already a literal value).
 */
export function resolveSecretRef(value, ctx, env = process.env) {
  if (typeof value !== 'string') return value
  const fromEnv = ENV_REF.exec(value)
  if (fromEnv !== null) {
    const resolved = env[fromEnv[1]]
    if (resolved === undefined) throw new Error(`environment variable "${fromEnv[1]}" is not set`)
    return resolved
  }
  const fromSecret = SECRET_REF.exec(value)
  if (fromSecret !== null) {
    const credentials = optionalService(ctx, 'credentials')
    if (credentials?.resolve === undefined) {
      throw new Error(`secret reference "${value}" requires the ctx.credentials service`)
    }
    return credentials.resolve(fromSecret[1])
  }
  return value
}

/** Strip anything that looks like a token/key from diagnostics. */
export function safeDiagnostic(error, maxBytes = 4096) {
  const raw = String(error?.message ?? error ?? 'unknown error')
  const scrubbed = raw
    .replace(/(token|api[_-]?key|secret|password|authorization)\s*[:=]\s*\S+/gi, '$1: [redacted]')
    .replace(/[A-Za-z]:\\[^\s"']+/g, '[path]')
  return scrubbed.slice(0, maxBytes)
}

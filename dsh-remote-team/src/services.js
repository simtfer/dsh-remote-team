/**
 * Optional Cordis service lookup.
 *
 * Cordis contexts are proxies: reading an undeclared `ctx.<service>` throws
 * `cannot get property "..." without inject` instead of returning undefined.
 * `ctx.get(name, false)` is the safe form — the `false` relaxes the "service
 * must already be active" check, and an unprovided service simply yields
 * undefined.
 *
 * A plain property read is kept as a fallback ONLY for non-Cordis contexts
 * (unit-test doubles), wrapped in try/catch so a real Cordis context that
 * lacks the service degrades to undefined rather than aborting activation.
 */

/**
 * @param {object} ctx - Cordis context or a lightweight test double.
 * @param {string} name - service name.
 * @returns {unknown} the service, or undefined when it is not available.
 */
export function optionalService(ctx, name) {
  if (ctx === null || ctx === undefined) return undefined
  try {
    if (typeof ctx.get === 'function') {
      const value = ctx.get(name, false)
      if (value !== undefined) return value
    }
    return ctx[name]
  } catch {
    return undefined
  }
}

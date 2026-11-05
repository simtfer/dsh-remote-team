/**
 * dsh-remote-team — Host entry for the third-party DSH bundle.
 *
 * Everything the plugin needs is obtained through the injected Cordis context.
 * No @deepseek-ai/* import happens at module load time, so the package can be
 * installed into a standalone profile with only its four peer packages present.
 *
 * Registrations are effects: disposing the plugin fiber unregisters every tool,
 * removes the optional guard listener, and disposes live activations.
 */

import { normalizeConfig, resolveRunStorePath } from './src/config.js'
import { optionalService } from './src/services.js'
import { MachineRegistry } from './src/registry.js'
import { RunStore } from './src/run-store.js'
import { DispatchPolicy } from './src/policy.js'
import { RemoteDispatcher } from './src/dispatch.js'
import { ProxyTeammates } from './src/proxy-teammate.js'
import { createTools } from './src/tools.js'

export const name = 'remote-team'

/** Hard dependencies. remoteExec / agentTeams / jobs / credentials are optional. */
export const inject = ['tools', 'subagents']

/**
 * Activate the bundle.
 * @param {object} ctx - Cordis context.
 * @param {object} rawConfig - deployment-owned configuration from cordis.patch.yml.
 */
export function apply(ctx, rawConfig) {
  const config = normalizeConfig(rawConfig)
  const logger = optionalService(ctx, 'logger')
  const remoteExec = optionalService(ctx, 'remoteExec')
  if (remoteExec === undefined) {
    logger?.warn?.('remote-team: ctx.remoteExec is unavailable; machine status will stay "unknown" until the dsh-remote seam is installed')
  }

  const registry = new MachineRegistry({ config, remoteExec, logger })
  const store = new RunStore(resolveRunStorePath(config.runStorePath))
  const policy = new DispatchPolicy({ config, registry })
  const dispatcher = new RemoteDispatcher({ ctx, config, registry, store, policy, logger })
  const teammates = new ProxyTeammates({ ctx, config, registry, dispatcher, logger })
  const tools = createTools({ ctx, config, registry, dispatcher, teammates, store })

  ctx.effect(() => {
    const disposers = []
    for (const tool of tools) disposers.push(ctx.tools.register(tool))
    if (config.enablePreExecuteGuard && typeof ctx.on === 'function') {
      disposers.push(ctx.on('tools/pre-execute', policy.preExecuteListener()))
    }
    return () => {
      while (disposers.length > 0) {
        const dispose = disposers.pop()
        try { dispose?.() } catch (error) { logger?.warn?.('remote-team: dispose failed: %o', error) }
      }
      void dispatcher.dispose()
    }
  })

  // Best-effort initial status refresh; a failed probe is data, never a startup failure.
  void registry.refresh().catch((error) => logger?.warn?.('remote-team: initial probe failed: %o', error))
  logger?.info?.('remote-team: %d machine(s), %d tool(s) registered', config.machines.length, tools.length)
}

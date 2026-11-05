/** Shared mock Cordis context for the plugin's dependency-free unit tests. */

export function makeContext({ subagents, remoteExec, agentTeams } = {}) {
  const tools = []
  const effects = []
  const listeners = []
  const services = { remoteExec, agentTeams, credentials: undefined }

  const ctx = {
    logger: { info() {}, warn() {}, error() {} },
    tools: {
      register(tool) {
        tools.push(tool)
        return () => {
          const index = tools.indexOf(tool)
          if (index >= 0) tools.splice(index, 1)
        }
      },
    },
    effect(fn) {
      const disposer = fn()
      effects.push(disposer)
      return () => {}
    },
    on(name, listener) {
      const entry = { name, listener }
      listeners.push(entry)
      return () => {
        const index = listeners.indexOf(entry)
        if (index >= 0) listeners.splice(index, 1)
      }
    },
    get(name) { return services[name] },
    subagents,
  }

  return {
    ctx,
    tools,
    effects,
    listeners,
    dispose() {
      for (const disposer of effects.splice(0)) disposer?.()
    },
  }
}

/** A controllable SubagentActivation whose result can be settled by the test. */
export function pendingActivation({ childId = 'remote-run-1' } = {}) {
  let resolveResult
  let rejectResult
  const result = new Promise((resolve, reject) => {
    resolveResult = resolve
    rejectResult = reject
  })
  const state = { disposed: false }
  const activation = {
    childId,
    result,
    async dispose() { state.disposed = true },
  }
  return {
    activation,
    state,
    settle(value) { resolveResult(value) },
    reject(error) { rejectResult(error) },
  }
}

export function completedActivation(text, stopReason = 'completed') {
  return {
    childId: 'remote-run-1',
    result: Promise.resolve({
      output: [{ type: 'text', text }],
      stopReason,
    }),
    async dispose() {},
  }
}

export function baseConfig(overrides = {}) {
  return {
    machines: [
      {
        id: 'dev-win',
        name: 'Dev Windows',
        provider: 'pi@dev-win',
        url: 'wss://dev-win:8787',
        cwd: 'D:\\work\\repo',
        tags: ['dev'],
        maxConcurrentRuns: 2,
      },
      {
        id: 'build-win',
        name: 'Build Windows',
        provider: 'pi@build-win',
        url: 'wss://build-win:8787',
        cwd: 'D:\\build\\repo',
        tags: ['build'],
        maxConcurrentRuns: 1,
      },
    ],
    maxParallel: 4,
    ...overrides,
  }
}

export function toolByName(tools, name) {
  const tool = tools.find((entry) => entry.name === name)
  if (tool === undefined) throw new Error(`tool "${name}" was not registered`)
  return tool
}

export const fakeExec = () => ({ agent: { id: 'lead' }, signal: new AbortController().signal })

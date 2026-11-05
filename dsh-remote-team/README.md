# dsh-remote-team

English | [中文](README.zh.md)

An independent third-party [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) bundle that lets DSH's **built-in agent-team** dispatch tasks to harnesses running on other Windows machines (Pi coding agent first), and returns results to the parent session. Full design: `../实现方案.md` (v1.1).

## Why a "local proxy teammate"

`spawn_teammate` reserves a `childId`; `ctx.subagents.startActivation()` therefore requires a provider implementing `prepareContinuable()`. That method only contributes a `seed` — the continuation manager always creates a **local in-process Agent**. A remote Pi process can never be a roster member directly (setting `freshProvider: pi@xxx` fails with `UNSUPPORTED_CAPABILITY`).

This bundle creates a normal local teammate, binds a machine id into its initial context, and has it call `remote_team_run`. Team messaging, task board, `wait_agent`, interruption and multi-turn follow-ups all keep working. Simple tasks can skip the team entirely with `remote_team_run({ wait: true })`.

## Install

The four upstream packages (`@deepseek-ai/dsh-remote`, `dsh-remote-agent`, `dsh-remote-client`, and the remote-enabled `dsh-subagent-pi`) currently live on the `feat/remote-harness-management` branch and are **not published**. Link them into the profile first, then:

```sh
dsh plugin --profile demo add <path-to>/dsh-remote-team
dsh --profile demo --dump-config
```

Node >= 22.19 and Pi >= 1.2.0 are required on the remote Windows machines. See README.zh.md for the full pre-install commands, `cordis.patch.yml` configuration, deployment and security notes.

## Tools

`remote_team_list`, `remote_team_probe`, `remote_team_route`, `remote_team_run`, `remote_team_parallel`, `remote_team_status`, `remote_team_output`, `remote_team_cancel`, `spawn_remote_teammate`, `assign_remote_task`.

`machine` is optional on every dispatch entry: when omitted, the router scores machines by tags, free capacity, online status and past success rate, and returns its reasoning.

## Transport security

`dsh-remote-agent` has no TLS. The bundle ships `remote-agent/wss-proxy.js` (TLS termination to a loopback agent), `install.ps1` (self-signed CA, per-machine certificate, token, scheduled tasks, firewall) and `tls.md`. Non-loopback `ws://` URLs are rejected at plugin startup. Tokens stay in environment/secret references; Pi credentials stay on the remote machine.

## Development

The plugin has **zero DSH runtime dependencies** — everything arrives through the injected `ctx`. Unit tests therefore run with a mock context and Node's built-in test runner:

```sh
npm test              # 29 mock-ctx unit tests
npm run check         # manifest, exports, patch consistency, JS syntax
npm run integration   # real Cordis Context + real ToolRuntime mounting this bundle
npm run verify:link   # real WebSocket protocol against a running agent (+ wss policy)
npm run verify:vm     # cross-machine check through a reverse TCP tunnel
```

`verify:link` connects to an already-running `dsh-remote-agent` and runs one real command (`hello`/`welcome`/`spawn`/`stdout`/`exit`); plain `ws://` is refused off-loopback. `verify:vm` drives the agent inside a VirtualBox Windows guest from a host-side WebSocket client — on 2026-11-05 it returned `node -v → v22.22.2`, `hostname → Win11-Test` (host: `tang`) and `win32|x64|Win11-Test`, all with `platform=windows` and `exit:0`. The guest firewall blocked inbound traffic with no elevation available, so the guest dials out to the host instead: **a development-only reverse tunnel, not the production path** (production uses `install.ps1` + `wss://`). Credentials come from environment variables, preferably `DSH_VM_PASSWORD_FILE`.

`npm run integration` is the important one: it proves the bundle actually loads into a DSH profile — all ten tools pass `ToolRegistry.register()`'s JSON-schema validation, the `inject` list resolves, a read-only call works, and disposal unregisters everything. Point it at a checkout with `DSH_REPO=/path/to/deepseek-harness` or a positional argument.

The upstream remote chain is covered separately by `vitest run packages/subagent/subagent-pi/tests/remote-pi.spec.ts` (real `dsh-remote-agent` + fake-Pi JSONL round trip). Note that vitest 4 has no `basic` reporter.

> If `vitest` fails with `EPERM`, check the ACL on `node_modules/.pnpm`: an empty DACL on those files denies everyone. Restore inheritance as the owner with `icacls <repo>\node_modules\.pnpm /reset /T /C /Q`.

## Known limitations

- `SubagentActivation` exposes only the final result, not Pi's JSONL event stream, so there is no per-line progress; `remote_team_output` returns final text.
- `assign_remote_task` dispatches using a teammate's bound machine but does not auto-inject results back via `send_message`; teammates use native team messaging for follow-ups.
- The Web panel is static; live data requires a Typert Remote API (P4).
- Remote runs are always `fresh`; `fork` stays local.

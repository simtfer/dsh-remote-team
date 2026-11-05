# dsh-remote-team

[English](README.md) | 中文

一个独立的 DeepSeek Harness 第三方 bundle：用 DSH **内置的 agent-team** 调度其他 Windows 电脑上的 Harness（首个实现为 Pi coding agent）执行任务，并把结果收回到父会话。

完整设计见 `../实现方案.md`（v1.1，7 项决策已定）。

## 它做什么

- 一次性装配 `dsh-remote` / `dsh-remote-client` / 每台机器一个 `dsh-subagent-pi` 实例，把四段手工 YAML 变成一次 `dsh plugin add`。
- 提供 10 个模型可见工具：列机器、探活、路由打分、派发、多机并行、查状态、取输出、取消、创建远程队友、按队友派任务。
- **模型按次选 `machine`**；省略时按 tags、并发余量、在线状态、历史成功率自动路由，并返回打分依据。
- 用「本地代理队友」把远程执行接入内置 agent-team：roster、任务板、`send_message`、`wait_agent`、中断照常，队友还能多轮追问。
- 自带 `wss-proxy` 与 Windows 安装脚本，给无 TLS 的 `dsh-remote-agent` 加一层证书校验。

### 为什么是「本地代理队友」

`spawn_teammate` 会为队友预留 `childId`，`ctx.subagents.startActivation()` 要求对应 provider 实现 `prepareContinuable()`；而该方法只返回一段 `seed`，continuation manager 独占 Agent 创建与执行——**进入 roster 的成员执行引擎必然是本地 in-process Agent**。所以远程 Pi 进程无法直接当队友（把 `freshProvider` 指向 `pi@xxx` 会在创建队友时以 `UNSUPPORTED_CAPABILITY` 失败）。

本插件用本地可续接 provider（默认 `spawn`）创建队友，把目标机器写进它的初始上下文，让它通过 `remote_team_run` 执行工作。代价是多一层本地 agent 中转；不需要团队语义的简单任务可直接 `remote_team_run({wait:true})`，不经过中转。

## 前置依赖（**必须先做**）

`@deepseek-ai/dsh-remote`、`dsh-remote-agent`、`dsh-remote-client` 与 `dsh-subagent-pi` 的 `mode: remote` 目前只在 `feat/remote-harness-management` 分支上，**未发布到 npm、也未合入 base bundle**。先把它们挂进你的 profile：

```sh
cd D:/code/github/deepseek-harness
# 四个包都要（subagent-pi 用仓库内已改好的那份）
dsh plugin --profile demo add ./packages/remote/remote
dsh plugin --profile demo add ./packages/remote/remote-client
dsh plugin --profile demo add ./packages/remote/remote-agent
dsh plugin --profile demo add ./packages/subagent/subagent-pi

dsh plugin --profile demo add D:/code/workbuddy-projects/ai-teams/dsh-remote-team
dsh --profile demo --dump-config     # 确认所有行都生效
```

若这些包已发布，改成 `dsh plugin --profile demo add dsh-remote-team` 即可。被控端还需要 Node ≥ 22.19、Git for Windows 与 `pi` 1.2.0+。

## 配置

`cordis.patch.yml` 里有两处机器清单，**必须保持一致**：

| 位置 | 作用 |
|---|---|
| `remote-client` 的 `machines` | 连接地址与 token（`${ENV_VAR}` 引用，不落盘） |
| `remote-team` 的 `machines` | `provider` 名、远端 `cwd`、tags、并发上限、`url`（用于 wss 校验） |

三个容易踩的坑：

1. `subagent-pi` 的 `args` 必须含 `--approve`：Pi 在 print/JSON 模式无法显示 project trust 提示，否则 `.pi/settings.json`、`.pi/extensions` 等受保护资源不加载。
2. `remote-team.machines[].cwd` 是**远端机器上的绝对路径**。`subagent-pi` 默认继承父 Session 的本地 cwd，远端不存在该路径会被 `cwd-missing` 拒绝；本插件在每次 `startActivation` 里显式传 `cwd`。
3. 非回环地址必须是 `wss://`。插件启动时会校验，明文 `ws://` 直接拒绝注册。
4. 若你的 profile 不支持 `${ENV_VAR}` 插值，改用 Cordis 的 `!!js` 表达式：`token: !!js "process.env.REMOTE_AGENT_TOKEN_DEV_WIN"`。凭据不要写死在 YAML 里。

控制端启动 DSH 前设置（信任自签 CA）：

```powershell
$env:NODE_EXTRA_CA_CERTS = "D:\...\remote-team-ca.pem"
$env:REMOTE_AGENT_TOKEN_DEV_WIN = "<install.ps1 生成的 token>"
```

## 模型可见工具

| 工具 | 说明 |
|---|---|
| `remote_team_list` | 机器清单 + 状态 + tags + 并发余量 + 已绑定的队友 |
| `remote_team_probe` | 刷新在线状态（可指定单台） |
| `remote_team_route` | 只返回推荐机器与打分依据，不开工 |
| `remote_team_run` | **唯一执行入口**；`machine` 可选，`wait=true` 同步拿结果 |
| `remote_team_parallel` | 多机并发扇出并汇总 |
| `remote_team_status` | 查 run 状态；`unknown` 表示结果未知，不是失败 |
| `remote_team_output` | 读最终输出（支持字符游标） |
| `remote_team_cancel` | `dispose()` 取消，远端 kill 进程树 |
| `spawn_remote_teammate` | 创建绑定机器的本地代理队友 |
| `assign_remote_task` | 用队友已绑定的机器派新任务 |

## 被控端（Windows）

```powershell
# 管理员 PowerShell，一次安装：CA + 一机一证书 + token + 两个计划任务 + 防火墙
.\remote-agent\install.ps1 -MachineId dev-win -ListenPort 8787 -AgentPort 8788 -Allow pi,node
```

安装后常驻两个进程：

```
node remote-agent/wss-proxy.js --host 0.0.0.0 --port 8787 --cert server.pem --key server.key --target ws://127.0.0.1:8788
dsh-remote-agent --host 127.0.0.1 --port 8788 --token <token> --allow pi,node
```

`wss-proxy` 只做 TLS 终结与帧转发，不改上游包；token 仍由 `dsh-remote-agent` 校验，等于双因子。开发期（M1/M2）可先用 Tailscale/WireGuard 加密网络层、直接连 `ws://<私网 IP>`，省掉证书管理；详见 `remote-agent/tls.md`。

## 安全边界

- 远端 agent 等同远程 shell：token 与远程 shell 访问等价，一机一 token，只放行控制端 IP。
- `--allow` 为空时拒绝一切；allowlist 按程序名，**不约束参数与工作目录**，所以插件侧额外做 `cwd` 映射与任务长度校验。
- Pi 没有内建权限系统，以启动账户权限运行；Windows 上请用低权限服务账户 + 目录 ACL + `--tools` 白名单（官方容器化方案全是 Linux-only）。
- Pi 的模型凭据留在被控机 `~/.pi/agent/auth.json`，一机一 key、可吊销，绝不下发。
- 断线一律标记 `unknown` 并保留 `remoteRunId`，**不自动重放**，避免重复执行。

## 已知限制（相对方案 v1.1）

- `SubagentActivation` 只暴露最终 `result`，没有 Pi JSONL 事件流，因此**没有逐行进度**；`remote_team_output` 返回最终文本。细粒度进度需要上游暴露事件或插件直连 `ctx.remoteExec.spawn()` 自行解码（P5 备选）。
- `assign_remote_task` 按队友绑定的机器直接派发并返回 runId，**不会自动把结果 `send_message` 回灌给队友**；队友多轮请走 team 原生 `send_message`，由队友自己再调 `remote_team_run`。
- Web 看板目前是静态说明面板；实时数据需要 Typert Remote API（P4）。
- `fork` 语义保持本地：远程一律 `fresh`。
- 代理队友的 `tools.restrict()` 作用域收缩未接（依赖当前 DSH 版本的 API 形态），persona 里用强约束代替；见 `presets/remote-worker.md`（可直接编辑）。

## 开发与验证

插件本体**零 DSH 运行时依赖**（只用注入的 `ctx` 与 Node 内置模块），因此可以独立跑单测：

```sh
cd dsh-remote-team
npm test              # 29 个 node:test 用例，mock context
npm run check         # 清单、exports、patch 一致性与全部 .js 语法检查
npm run integration   # 真实 Cordis Context + 真实 ToolRuntime 装载本插件
```

三档验证各管一段，缺一不可：

| 命令 | 验证什么 | 需要什么 |
|---|---|---|
| `npm test` | 派发、路由、并发、取消、断线不重放、队友绑定 | 只要 Node ≥ 22.19 |
| `npm run integration` | **插件能否真的装进 DSH**：10 个工具通过 `register()` 的 schema 校验、inject 解析、只读调用、dispose 撤销 | DSH 仓库的 `lib/` 产物与 `node_modules` 可读；可用 `DSH_REPO` 或位置参数指定路径 |
| 上游 `vitest` | 远程链路 M1：真实 `dsh-remote-agent` + Pi JSONL 往返、allowlist 拒绝、参数校验 | 完整 DSH 开发环境 |

```sh
cd D:/code/github/deepseek-harness
./node_modules/.bin/vitest run \
  packages/subagent/subagent-pi/tests/remote-pi.spec.ts \
  packages/remote/remote/tests/seam.spec.ts
```

> **本机踩过的坑（已解决）**：`node_modules/.pnpm/` 下 9 万个文件的 DACL 被清空（`rules=0`，等于拒绝所有人），导致 `vitest` 报 `EPERM`；换系统 Node、清 `NODE_OPTIONS`、.NET 直读都无效。根因不是代码也不是沙箱。以 owner 身份恢复继承权限即可：
>
> ```powershell
> icacls "D:\code\github\deepseek-harness\node_modules\.pnpm" /reset /T /C /Q
> ```
>
> 修复后 15/15 上游测试通过。另外 vitest 4 不支持 `--reporter=basic`，不要加这个参数。

## 目录

```
index.js               Host 入口：apply / inject（纯 ESM，无构建）
client.js              Web 半侧：插件详情页 slot
cordis.patch.yml       一次装配所有 Host 行
src/config.js          配置校验（含 wss 强制）
src/tool.js            零依赖的 ToolDefinition 构造器
src/registry.js        机器画像、打分路由、并发闸门
src/dispatch.js        派发 / 并行 / 取消 / OUTCOME_UNKNOWN
src/run-store.js       JSONL append-only 任务日志
src/policy.js          任务校验 + 并发策略
src/credentials.js     密钥引用解析 + 诊断脱敏
src/proxy-teammate.js  本地代理队友
src/tools.js           10 个模型可见工具
presets/               可编辑的队友 persona
remote-agent/          wss-proxy、install.ps1、TLS 说明
tests/                 node:test 自测（mock ctx）
```

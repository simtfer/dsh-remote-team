# dsh-remote-team

[English](./dsh-remote-team/README.md) | 中文

让 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的**内置 agent-team** 调度其他 Windows 电脑上的 Harness（首个实现为 [Pi coding agent](https://github.com/earendil-works/pi)）执行任务，并把结果收回到父会话。

插件是**独立的第三方 bundle**（`dsh.bundle.patch` + 纯 ESM，零 DSH 运行时依赖），不改 DSH 内核、不重写传输层：它只把已有的远程执行链路组装起来，补上团队桥接、按次选机器、凭据与任务持久化、状态治理和安全边界。

> **当前状态**：代码与自动化测试全部通过（29 单测 / 静态检查 / 13 项真实装载 / 15 项上游 e2e），并已在独立 Windows VM 上完成**跨机命令执行验证**（宿主 WebSocket 客户端 → VM 内的 `dsh-remote-agent` → 真实 `node -v`、`hostname` 等，全部 `platform=windows` + `exit:0`）。`wss` 部署、`install.ps1` 实跑与真实 Pi prompt 任务仍需管理员权限 / 模型凭据，详见 [实现方案.md](./实现方案.md) §14。

## 仓库内容

| 路径 | 内容 |
|---|---|
| [`dsh-remote-team/`](./dsh-remote-team/) | 插件本体，可单独 `dsh plugin add`；含双语 README、被控端安装脚本、测试与验证脚本 |
| [`实现方案.md`](./实现方案.md) | 设计文档 v1.1：源码盘点、7 项决策、架构分层、实施阶段与状态记录 |
| `.gitignore` | 排除本地会话数据、依赖，以及运行期生成的 CA 私钥 / 证书 / token / 任务日志 |
| [`LICENSE`](./LICENSE) | MIT 许可；`dsh-remote-team/` 内另有一份，便于插件单独分发 |

## 核心能力

- **一次装配**：`cordis.patch.yml` 把 `dsh-remote`、`dsh-remote-client` 和每台机器一个 `dsh-subagent-pi` 实例合并成一次 `dsh plugin add`。
- **按次选机器**：10 个模型可见工具，派发时 `machine` 可省略，由 tags、并发余量、在线状态、历史成功率打分路由。
- **本地代理队友**：`spawn_teammate` 固定要求本地可续接 provider（`prepareContinuable()` 只贡献 `seed`，continuation manager 独占 Agent 创建），因此远程 Pi 进程无法直接进 roster。插件用本地活队友调用 `remote_team_run`，从而保留任务板、`send_message`、`wait_agent`、中断与多轮追问；简单任务可用 `remote_team_run({ wait: true })` 跳过这层中转。
- **传输安全**：被控端内置 `wss-proxy` 做 TLS 终结，`install.ps1` 生成自签 CA、一机一证书、token、计划任务与防火墙规则；非回环 `ws://` 在插件启动校验时直接拒绝。

## 快速开始

### 1. 前置：上游四个包

`dsh-remote` / `dsh-remote-agent` / `dsh-remote-client` 和 `dsh-subagent-pi` 的 `mode: remote` **尚未发布到 npm、也未合入 base bundle**，目前只在 [`simtfer/deepseek-harness` 的 `feat/remote-harness-management`](https://github.com/simtfer/deepseek-harness/tree/feat/remote-harness-management) 分支上。先把它们挂进 profile：

```sh
cd /path/to/deepseek-harness
dsh plugin --profile demo add ./packages/remote/remote
dsh plugin --profile demo add ./packages/remote/remote-client
dsh plugin --profile demo add ./packages/remote/remote-agent
dsh plugin --profile demo add ./packages/subagent/subagent-pi
```

### 2. 安装本插件

```sh
dsh plugin --profile demo add /path/to/dsh-remote-team/dsh-remote-team
dsh --profile demo --dump-config      # 确认 patch 中的所有行都生效
```

编辑 `dsh-remote-team/cordis.patch.yml` 里两处 `machines`（`remote-client` 的连接地址与 token、`remote-team` 的 provider / 远端 `cwd` / tags / 并发上限），**两处必须保持一致**。三个易踩的坑：`subagent-pi` 的 `args` 要含 `--approve`；`cwd` 是**远端机器上的绝对路径**；token 走 `${ENV_VAR}` 引用，不要写死在 YAML 中。

### 3. 被控端（Windows，管理员 PowerShell）

```powershell
.\remote-agent\install.ps1 -MachineId dev-win -ListenPort 8787 -AgentPort 8788 -Allow pi,node
```

被控端需 Node ≥ 22.19、Git for Windows、Pi ≥ 1.2.0；控制端启动 DSH 前设置 `NODE_EXTRA_CA_CERTS`（信任自签 CA）与对应 token 环境变量。完整配置、TLS 方案与安全边界见 [中文 README](./dsh-remote-team/README.zh.md)。

### 4. 验证

```sh
cd dsh-remote-team
npm test              # 29/29，mock context 单测
npm run check         # 清单、exports、patch 一致性、23 个 JS 语法检查
npm run integration   # 13/13，真实 Cordis Context + ToolRuntime 装载
npm run verify:link   # 连一台已运行的 agent 跑真实命令（wss 策略校验）
npm run verify:vm     # VirtualBox 跨机验证（反向隧道，见中文 README）
```

上游远程链路另由 `vitest run packages/subagent/subagent-pi/tests/remote-pi.spec.ts packages/remote/remote/tests/seam.spec.ts` 覆盖（15/15，真实 `dsh-remote-agent` + fake-Pi JSONL 往返）。

**真机结果（2026-11-05）**：在独立 Windows VM 上，宿主的 WebSocket 客户端经开发期反向隧道驱动 VM 内的 agent 执行 `node -v → v22.22.2`、`hostname → Win11-Test`（宿主为 `tang`）、`win32|x64|Win11-Test`，三条均 `platform=windows` + `exit:0`。因 VM 防火墙阻断入站且无提权通道，改用 VM 主动外连的反向隧道；**这不是生产路径**，生产仍走 `install.ps1` + `wss://`。

## 文档导航

| 文档 | 内容 |
|---|---|
| [插件 README（中文）](./dsh-remote-team/README.zh.md) | 完整配置、10 个工具、部署步骤、安全边界、已知限制、踩坑与真机验证记录 |
| [Plugin README (English)](./dsh-remote-team/README.md) | English overview |
| [TLS 方案](./dsh-remote-team/remote-agent/tls.md) | 自签 CA、证书轮换与开发期替代通道 |
| [队友 persona](./dsh-remote-team/presets/remote-worker.md) | 可直接编辑的代理队友行为约束 |
| [跨机验证脚本](./dsh-remote-team/scripts/verify-cross-machine.mjs) | 开发期反向隧道验证（防火墙不可改时） |
| [实现方案](./实现方案.md) | 设计依据与决策记录；§14 是当前实施状态 |

## 安全须知

远端 agent 等价于一个远程 shell：一机一 token，只放行控制端 IP；`--allow` 白名单只按程序名、不约束参数与工作目录。Pi 的模型凭据留在被控机 `~/.pi/agent/auth.json`，绝不下发。断线一律标记 `unknown` 并保留 `remoteRunId`，**不自动重放**。CA 私钥、证书与 token 均由安装脚本现场生成，已在 `.gitignore` 中排除，不要提交。

## 尚未完成

- **真实 profile 装配的 CLI 路径**：`dsh plugin add` 被本机 pnpm 的 Windows symlink 问题挡住；已用 `--patch` + `--dump-config` 确认 `cordis.patch.yml` 六行全部生效，但依赖安装未跑通。
- **`install.ps1` 实跑 + `wss` 链路**：需要被控机管理员权限加入站规则；目前只做过 PowerShell AST 解析与开发期反向隧道验证。
- **真实 Pi prompt 任务 / 两台并行**：需要模型 API key 与第二台被控机。
- P4 凭据轮换与实时看板、P5 产物回传与 Pi RPC 双向桥。

许可：[MIT](./LICENSE)（插件目录内另附一份，便于单独分发）。

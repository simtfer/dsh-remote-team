# 传输安全说明

## 为什么需要这一层

`dsh-remote-agent` 用 `ws` 的 `WebSocketServer({ port, host })` 做原生 HTTP 升级，**没有任何 TLS**。明文 `ws://` 会把预共享 token 和全部任务输出（可能含源码、路径、密钥片段）暴露给网络。而控制端 `remote-client` 用的是 Node 全局 `WebSocket`（undici），**原生支持 `wss://`**，信任链走系统 CA 或 `NODE_EXTRA_CA_CERTS`。

因此最省事、且不改上游包的做法是：**被控机加一层 TLS 终结，控制端零代码改动**。

## 方案选择

| 方案 | 适用 | 说明 |
|---|---|---|
| **插件内置 `wss-proxy`（交付默认）** | 正式部署 | 被控机 `https:8787` → 明文转发到 `127.0.0.1:8788` 的 remote-agent；自签 CA + 一机一证书；控制端 `NODE_EXTRA_CA_CERTS` 信任。自包含、可把「非回环必须 wss」做成插件启动硬校验 |
| Tailscale / WireGuard | 开发期 M1/M2、跨网络 | 网络层加密，remote-agent 绑私网地址，URL 仍写 `ws://<私网 IP>`；零证书管理，顺带解决 NAT |
| Caddy / stunnel 反代 | 已有运维体系 / 内网域名 | 证书由反代管理，把 `remote-agent` 放在它后面 |
| 改上游 `remote-agent` 加 TLS | 不推荐 | 要维护上游分叉，与「第三方 bundle 不侵入主干」冲突 |
| 明文 `ws://` 绑 `0.0.0.0` | **禁止** | token 与输出裸奔；插件启动会拒绝 |

## 证书生命周期

- `install.ps1` 首次运行生成 CA（`ca.key` / `ca.pem`，3650 天），**CA 私钥应离线保管**。
- 每台机器一份服务器证书（825 天），SAN 含机器名、`机器名.local` 与本机 LAN IP。
- `-RotateCert` 只轮换服务器证书，不换 CA，控制端无需改 `NODE_EXTRA_CA_CERTS`。
- token 与服务器私钥、CA 私钥都用 `icacls` 去掉继承、只授当前用户。
- token 不写进 `cordis.yml`，由 launcher 运行时从文件读入，控制端用 `${REMOTE_AGENT_TOKEN_*}` 环境变量注入。

## 控制端配置

```powershell
$env:NODE_EXTRA_CA_CERTS = "<path>\ca\ca.pem"   # 启动 dsh 之前设置
$env:REMOTE_AGENT_TOKEN_DEV_WIN = "<token>"
```

`cordis.patch.yml` 里写 `url: 'wss://<机器名或IP>:8787'`。插件 `normalizeConfig()` 会拒绝一切非回环的 `ws://`；仅本机 M1 验证允许 `ws://127.0.0.1`。

> Desktop（Electron）打包版若读不到 `NODE_EXTRA_CA_CERTS`，把 `ca.pem` 导入 Windows「受信任的根证书颁发机构」即可（只导公钥，不导私钥）。

## 排查

| 现象 | 检查 |
|---|---|
| 启动即报 `plaintext ws:// on a non-loopback host` | 换成 `wss://`，或把该机器放到 Tailscale 私网后再评估 |
| 连接报证书不受信任 | 控制端 `NODE_EXTRA_CA_CERTS` 是否指向正确的 `ca.pem`；证书 SAN 是否包含 URL 里的主机名/IP（用 IP 连就要有 `IP.1`） |
| 证书通过但 token 被拒 | 控制端环境变量与 `agent-token.txt` 是否一致；token 文件是否被换行符污染 |
| `wss-proxy` 起不来 | `ws@8` 是否装在该机器证书目录；8788 上的 `dsh-remote-agent` 是否已启动 |
| 断线后结果不确定 | 这是设计：`unknown` 不等于失败，用 `runId` 与 `remoteRunId` 人工核对，插件不会自动重放 |

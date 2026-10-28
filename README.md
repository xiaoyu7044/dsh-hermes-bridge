# hermes-bridge

**让两个 AI Agent 互相派活：DeepSeek Harness (DSH) ↔ Hermes Agent。**

一台机器上只有一个 AI 是不够的：一个跑在你电脑上、能开终端能 SSH；另一个跑在手机上、
随时在你手边。这个项目把它们接起来，互为执行器——

- 手机上想到什么，让 DSH 转给电脑上的 Hermes 去做（查日志、改配置、部署、跑脚本），结果回手机
- 电脑上想让手机干活（看屏幕、读电量、跑手机里的脚本），把任务派过去，结果回电脑
- 跨机器、跨 NAT 都行：一台公网 relay 做中转，双方都只做出站连接

```
┌──────────── 手机 / 远程 DSH ────────────┐        ┌────────── 你的主机 ──────────┐
│  call_hermes 工具                        │        │  relay 执行器（Python）       │
│    │                                     │        │    │                         │
│    └─ relay.js ──┐                       │        │    └─ 跑 hermes -z           │
│  phone-agent ◄───┼── 任务/结果           │        │      (Hermes Agent 全工具)   │
└──────────────────┼───────────────────────┘        └──────────────┬───────────────┘
                   │                                               │
             ┌─────▼───────────────────────────────────────────────▼─────┐
             │            公网 relay（HTTP + SSE，按 client 分发）       │
             └───────────────────────────────────────────────────────────┘
```

同机自用不需要 relay：插件会退化成 `execFile` 直接调本机 `hermes`。

## 仓库结构

| 路径 | 说明 |
|---|---|
| `plugin/` | DSH 插件包：`hermes-bridge`（call_hermes 工具）、`phone-agent`（远程执行器） |
| `relay/` | Hermes 侧脚本：relay 执行器 `hermes_exec_relay.py`、发起端 `dsh_phone.py`、systemd 单元 |
| `docs/` | 架构、协议、安全说明 |
| `tools/scan_secrets.py` | 发布前自检：扫密钥/个人路径/内网地址 |

分支 `hd` 另有：本机 DSH（HD）事件监控插件 `hd-events`、ACP 双向调用客户端、HD 集成说明。

| 分支 | 插件版本 | 内容 |
|---|---|---|
| `main` | 0.6.x | 全量：call_hermes（local/relay）+ phone-agent + hd-events + ACP 客户端 |
| `hd` | 跟随 `main` | 同一份代码，留作 HD 相关的开发分支 |

npm 的 `latest` 与 `main` 一致：`npm i dsh-hermes-bridge`。

## 三步跑起来

### 1. Hermes 侧：起执行器

```sh
mkdir -p ~/.hermes/relay ~/.hermes/logs
cp relay/hermes_exec_relay.py ~/.hermes/relay/
cp relay/client.example.json ~/.hermes/relay/client_server_exec.json   # 填 relay_url/token
chmod 600 ~/.hermes/relay/client_server_exec.json
# 改好路径后装成用户服务
cp relay/hermes-exec-relay.service ~/.config/systemd/user/
systemctl --user daemon-reload && systemctl --user enable --now hermes-exec-relay
```

### 2. DSH 侧：装插件 + 配置

```sh
dsh plugin --profile <profile> add /path/to/plugin
cp plugin/hermes-bridge.example.json ~/.dsh/hermes-bridge.json   # 改成你的 relay/token/peer
chmod 600 ~/.dsh/hermes-bridge.json
```

重启 DSH。日志里应出现：

```
[hermes-bridge] 已连上中转（client=<id> peer=<peer>）
[phone-agent] 已启动：等待 exec 任务
```

### 3. 双向验证

```sh
# 手机 → 本机 Hermes：在 DSH 会话里
调用 call_hermes 工具，任务：只回复三个字「通了」

# 本机 → 手机：在 Hermes 这边
python3 ~/.hermes/relay/dsh_phone.py "只回复三个字：收到了"
```

## 协议（摘要）

| 消息 | 方向 | 结构 |
|---|---|---|
| 调用 | 调用方 → 执行器 | `{"kind":"call_hermes","id","task","timeout_s"}` |
| 结果 | 执行器 → 调用方 | `{"kind":"result","id","ok","text","elapsed_ms"}` |
| 派任务 | 本机 → 手机 | `{"kind":"exec","id","task"}` |
| 手机结果 | 手机 → 本机 | `{"kind":"exec_result","id","ok","text"}` |
| 心跳 | 双方 | `{"kind":"ping"}` / `{"kind":"pong"}` |

relay 侧：`GET /health`、`GET /clients`、`POST /send`、`GET /events`（SSE）。详见 `docs/protocol.md`。

## 安全

- **一个 client 一个 token**，按用途拆（执行器 / 调用端 / 手机），任意一把可独立吊销
- token、模型 key 只放在本机 `600` 权限的配置文件里；本仓库只有 `.example`
- 跨机推送走 relay 回投，手机/内网端不需要暴露任何入站端口
- 接到 `call_hermes` 就等于拿到了那台机器上 Hermes 的全部工具权限——**按这个前提做权限隔离**

细节见 `docs/security.md`。

## 许可

MIT

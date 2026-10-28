# dsh-hermes-bridge

**DeepSeek Harness (DSH) ↔ Hermes Agent 互通插件包。**

在 DSH 会话里注册一个 `call_hermes` 工具：把任务交给另一台机器上的 Hermes Agent 执行，拿回结果。
反方向还有 `phone-agent`：让远端把任务派给这台 DSH 跑。

两种传输：

| 传输 | 适用 | 原理 |
|---|---|---|
| `local` | 同一台机器 | `execFile` 直接跑本机 `hermes` |
| `relay` | 跨机 / 手机 / NAT 后 | 经一台公网 relay 中转，双方都是出站连接，对端不需要公网入口 |

## 安装

```sh
# 本地目录（开发/验证）
dsh plugin --profile <profile> add /path/to/plugin

# 从 npm
dsh plugin --profile <profile> add dsh-hermes-bridge

# 从 git 仓库子目录
dsh plugin --profile <profile> add git+https://github.com/<you>/hermes-bridge.git#plugin
```

安装后验证插件层是否注册：

```sh
dsh --profile <profile> --dump-config | grep -E "hermes-bridge|phone-agent"
```

> `cordis.patch.yml` 里用的是**模块标识符**（`dsh-hermes-bridge`、`dsh-hermes-bridge/phone-agent.js`），
> 不是绝对路径——绝对路径只适合手工拷贝，换机器就废。

## 配置

复制 `hermes-bridge.example.json` 到 `~/.dsh/hermes-bridge.json`，权限 `600`：

```json
{
  "relay_url": "https://relay.example.com:8843",
  "token": "<this client's token>",
  "client_id": "phone",
  "peer": "server-exec",
  "dsh_bin": "dsh"
}
```

| 键 | 说明 |
|---|---|
| `relay_url` | relay 地址。没有就退化成 `local` 传输 |
| `token` / `client_id` | 本机在 relay 上的身份，一个 client 一个 token |
| `peer` | 对端 client id（`call_hermes` 把任务发给谁） |
| `dsh_bin` | `dsh` 可执行文件；只给 `phone-agent` 用 |
| `deepseek_api_key` | 可选。给 `dsh headless` 子进程注入模型 key（见下文「凭据」） |
| `dsh_env` | 可选。任意键值，原样注入 `dsh headless` 子进程环境 |

也可以用环境变量覆盖：`HERMES_RELAY_URL`、`HERMES_RELAY_TOKEN`、`HERMES_RELAY_CLIENT`、
`HERMES_RELAY_PEER`、`HERMES_BRIDGE_CONFIG`、`HERMES_TIMEOUT`（毫秒，默认 600000）。

## call_hermes

```
call_hermes(task: "把服务重启一下并复验健康检查")
call_hermes(task: "…", timeout_s: 1800)
call_hermes(task: "…", session: "triage")      // 需要 Hermes 侧持久会话时透传
```

返回 `{ ok, text, elapsed_ms }`。失败时 `ok=false`，`text` 是原因。

## phone-agent

让远端指挥这台 DSH：

1. 收 relay 消息 `{"kind":"exec","id":"…","task":"…"}`
2. 跑 `dsh headless --json "<task>"`，从 NDJSON 里取 `type:final` 作为答复
3. 回投 `{"kind":"exec_result","id":"…","ok":true,"text":"…"}`
4. 顺带：弹一条 Android toast、把回执推到指定 IM（可选）

任务默认 900 秒超时，串行执行（同一时间只跑一个 `dsh headless`，避免会话/工具冲突）。

## 凭据（必读）

- `~/.dsh/hermes-bridge.json` 里有 relay token，**权限 600，别进版本库、别进备份**。
- `phone-agent` 调 `dsh headless` 用的是 headless profile，它**读不到**桌面/App 侧配置的模型 key。
  典型报错：`MISSING_CREDENTIAL: no API key for provider route "…"`。
  解决：在配置里给 `deepseek_api_key`（或 `dsh_env.DEEPSEEK_API_KEY`），插件会注入子进程环境。
- relay 上一个 client 一个 token，按用途分开（执行器 / 调用端 / 手机），任意一把可单独吊销。

## 为什么是 `dsh headless --json`

`dsh headless "<task>"` 的裸 stdout 混着插件启动日志，直接取会把 `[hermes-bridge] 已启动…`
当成答复返回给调用方。`--json` 输出 NDJSON 运行事件，取 `type=final` 的那条才是最终答复。
插件自身日志因此统一走 `console.error`，不污染 stdout。

## 常见问题

| 现象 | 原因 | 处理 |
|---|---|---|
| `dsh plugin add` 说 Already up to date，但代码没变 | pnpm 把本地目录建成**软链**，目录没换它就不重装 | 换目录名后再 `add`，或先 `remove` 再 `add` |
| 装到 `/tmp` 下，重启后失效 | 软链指向临时目录 | 把插件目录放到持久位置（如 `~/.dsh/local/…`）再登记 |
| 手机 guest 里 `unzip: command not found` | 精简 rootfs 未装 unzip | `python3 -c "import zipfile;zipfile.ZipFile('x.zip').extractall('dir')"` |
| 调用立刻返回「执行超时（1s）」 | `timeout_s`（秒）被当成毫秒用 | 已在 0.5.4 修复：`Math.round(secs * 1000)` |
| `INVALID_REQUEST` 来自工具参数 | DSH 的 `defineTool.parameters` 必须是 `type:'object'` + `properties` + `required:[]` 数组 | 按 JSON Schema 写 |

## hd-events（分支 `hd`）

监控本机 HD 的会话文件，判定「在干活 / 卡住 / 缓过来」，事件走 webhook（HMAC）或 relay 推给你。
纯空闲不告警。详见 `docs/hd-integration.md`。

```sh
HD_STALL_MIN=20 HD_HEARTBEAT_MIN=0 dsh --profile <profile>
```

## 许可

MIT

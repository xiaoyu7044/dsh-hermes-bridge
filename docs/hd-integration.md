# HD 集成（本机 DSH）

分支 `hd` 在基础插件上加了 `hd-events`：让 Hermes 知道**本机 HD（DSH）到底在干活还是卡住了**，
以及两个 ACP 客户端，供在 Hermes 里直接驱动一个 ACP 会话。

## 为什么不是「看进程」

进程活着不等于在工作：DSH 可能卡在一次模型请求上，也可能在等一个永远不返回的工具。
唯一可靠的活跃信号是**会话文件在写**。`hd-events` 只看 `~/.dsh/sessions/` 下的 `.jsonl` / `.zstd`：

| 状态 | 判定 | 动作 |
|---|---|---|
| 干活中 | 最近有写入 | 无事（不打扰） |
| 卡住 | 曾活跃，连续 `HD_STALL_MIN` 分钟无写入 | 推 `hd_stall` |
| 缓过来 | 卡住之后又有写入 | 推 `hd_resumed` |
| 纯空闲 | 启动后一直没写过 | **永不告警**（空闲 ≠ 卡死） |

## 事件出口（自动选择）

1. **Hermes webhook**：`POST <url>` + `X-Hub-Signature-256: sha256=<HMAC-SHA256(body, secret)>`
   - 订阅配置从 `~/.hermes/webhook_subscriptions.json` 自动读取
   - 兼容三种文件形状：`{"hd-events": {...}}`（Hermes 实际写的）、`{"subscriptions": [...]}`、`[...]`
   - 这条通道不经过模型，零 token 成本
2. **relay**：没有 webhook 时，复用 `hermes-bridge` 的 relay 连接发一条 `notify`，远端 Hermes 转投 IM
3. 都没有：只写 stderr

## 配置

| 变量 | 默认 | 说明 |
|---|---|---|
| `DSH_HOME` | `~/.dsh` | DSH 根目录 |
| `HD_SESSIONS_DIR` | `$DSH_HOME/sessions` | 会话目录 |
| `HD_STALL_MIN` | `20` | 停滞阈值（分钟），`0` 关闭 |
| `HD_HEARTBEAT_MIN` | `0` | 心跳间隔（分钟），`0` 关闭 |
| `HD_EVENT_URL` / `HD_EVENT_SECRET` | 自动 | 显式指定 webhook，优先于订阅文件 |
| `HERMES_HOME` | `~/.hermes` | 找 `webhook_subscriptions.json` |

## 单实例

`$TMPDIR/hd-events-<uid>.lock` 存 pid。启动时若 pid 还活着就退出——多 profile 同时加载插件时
不会出现两条通知流；宿主崩溃留下的僵尸锁会在下次启动时自动接管。

## ACP 客户端

`clients/acp-client.py` / `acp-client.js` 是通用 ACP 客户端：给一个 spawn 命令和一个任务，
它建会话、发任务、收回复流，事件驱动等待（不是 sleep 轮询）。

```sh
python3 clients/acp-client.py "dsh acp" "把构建跑通，只回结论"
node    clients/acp-client.js  "dsh acp" "检查一下 migrations"
```

ACP 的坑：`session/update` 通知可能在 `session/prompt` 返回之后才到齐，
所以必须等「收到过 update 且流结束」双条件，不能只等 prompt 返回。

## 踩过的坑

- **订阅文件形状**：旧实现只认 `{subscriptions:[...]}`，而 Hermes 写的是 `{"hd-events": {...}}`，
  结果取到空 secret，HMAC 校验失败 401，事件静默丢失。现在三种形状都认，并且有单测。
- **`recursive: true` 在部分平台不支持**：降级成 30 秒扫一次 mtime，逻辑不变。
- **别用 `require()`**：插件是 ESM，`require` 不存在；`relay.js` 直接静态 `import` 即可（它没有导入期副作用）。

# 架构

## 三个角色

| 角色 | 跑在哪 | 职责 |
|---|---|---|
| 调用方 | DSH（含手机 App 内的 DSH） | 注册 `call_hermes`，把任务打包成消息发出去，等带同一个 `id` 的结果 |
| 执行器 | 有 Hermes 的主机 | 订阅 relay，串行执行 `hermes -z`，把结果投回调用方 |
| relay | 有公网地址的机器 | 按 client id 分发消息；SSE 下发、HTTP 上报；离线补投 |

`phone-agent` 是镜像角色：它让远端把任务派给这台 DSH，用 `dsh headless --json` 跑完回投。

## 为什么需要 relay

手机、家里的主机都在 NAT 后面，彼此没有公网入口。让任意一端开端口都意味着暴露整个内网。
relay 只做一件事：给每个 client 一条 token，收到 `/send` 就转发给目标 client 的 SSE 连接。
双方都只做出站连接，因此不需要端口映射、不需要动态 DNS。

同一台机器上没必要绕远路：插件检测到没有 `relay_url` 时直接 `execFile` 调本机 `hermes`。

```
DSH (call_hermes)
      │  1. 本地能跑？ ──是──▶ execFile(hermes -z task) ──▶ 结果
      │
      └─ 否 ──▶ relay /send ──▶ [relay] ──SSE──▶ 执行器 ──▶ hermes -z
                                                        │
      DSH  ◀── SSE ◀── [relay] ◀── /send (result, 同 id) ┘
```

## 执行模型

- **串行**：执行器内部一个队列，同一时间只跑一个 `hermes -z`。并发会争抢同一份会话与工具状态。
- **一次性入口**：用 `hermes -z` 而不是 `hermes chat -q`——后者带启动横幅、提示抬头和插件告警，远程调用方拿到没法用。
- **结果截断**：超过 8000 字符时保留头尾各 4000，中间标注省略量。手机 DSH 回投同理。
- **超时**：调用方默认 600 秒（可传 `timeout_s`），执行器另有 30 秒宽限；手机执行默认 900 秒。
- **瞬时失败重试**：`hermes` 非零退出且耗时 <3 秒（常见于启动锁竞争）自动重试一次，并把 stderr 留在日志里。

## 会话

`call_hermes` 的 `session` 参数透传到执行器，落到 `hermes -z … --continue <session>`：
同名调用共享上下文，适合「检查 → 修复 → 复验」这类多步任务。不传就是干净的一次性会话，token 最省。

## 失败与恢复

| 层 | 失败 | 表现 | 恢复 |
|---|---|---|---|
| SSE | relay 重启 / 网络抖动 | 连接断 | 指数退避重连，最长 30 秒 |
| relay | 对端离线 | 消息排队 | 对端重连后补投 |
| 执行器 | `hermes` 启动瞬断 | 1~2 秒失败 | 自动重试一次 |
| 执行器 | 任务超时 | 返回 `ok=false` + 已产出的部分 | 调用方决定是否拆分任务 |

## 事件监控（分支 `hd`）

`hd-events` 盯本机 DSH 的 `~/.dsh/sessions/`：有写入 = 在干活；连续 N 分钟没写入 = 疑似卡死。
事件经 webhook（HMAC 签名）直推，不经过 LLM，因此零 token 成本。

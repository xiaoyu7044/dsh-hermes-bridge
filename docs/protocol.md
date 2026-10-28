# 协议

## relay HTTP 接口

所有接口都要带 `client` 与 `token`（一 client 一 token）。

| 方法 | 路径 | 用途 |
|---|---|---|
| GET | `/health` | 存活检查，返回在线 client 数 |
| GET | `/clients?client=&token=` | 列出在线 client |
| POST | `/send?client=&token=` | 发消息：`{"to":"<peer>","payload":{…}}` |
| GET | `/events?client=&token=` | SSE 下行流，15 秒一次 `: keepalive` |

`/send` 的响应只表示「relay 收下了」，不代表对端处理完。对端离线时消息排队，重连后补投。

## 消息类型

### 调用 Hermes（A 方向）

```json
{"kind":"call_hermes","id":"<uuid>","task":"…","session":"可选","timeout_s":600}
```

回投：

```json
{"kind":"result","id":"<同一 uuid>","ok":true,"text":"…","elapsed_ms":12034}
```

`id` 是唯一关联键：调用方按 `id` 等结果，执行器必须原样带回。

### 指挥 DSH（B 方向）

```json
{"kind":"exec","id":"<uuid>","task":"…","timeout_s":900}
```

回投：

```json
{"kind":"exec_result","id":"<uuid>","ok":true,"text":"…","elapsed_ms":45120}
```

### 通知（可选，零 LLM）

```json
{"kind":"notify","message":"…","ok":true}
```

relay 侧把这类消息投给配置好的 webhook 订阅，直接变成一条 IM 消息，不进模型。

### 心跳

```json
{"kind":"ping"}   →   {"kind":"pong","ts":1793199338.09}
```

## 客户端的实现要点

- **SSE 逐行读**：relay 发 `data: {json}`，也发 `: keepalive` 心跳行，后者要跳过。
- **断线退避**：2 → 4 → 8 … 最长 30 秒；重连后不需要补发请求，relay 会补投。
- **结果按 id 匹配**：同一连接上可能同时有多个任务的结果，不能按到达顺序取。
- **超时要自己算**：`timeout_s` 是秒；内部定时器是毫秒，转换必须显式 `Math.round(secs * 1000)`。
  这个错在 0.5.3 及之前真实存在——表现是「调用立刻返回执行超时（1s）」。

## 手机端执行（`dsh headless`）

```
dsh headless --json "<task>"
```

输出是 NDJSON 运行事件，最终答复在 `type == "final"` 的那条事件里。
不要取裸 stdout：插件启动日志与答复混在一起，会把 `[hermes-bridge] 已启动…` 当成结果。

# 安全

## 先说最要紧的一句

**持有 relay token 就等于持有那台机器的执行权。** 消息最终会变成 `hermes -z "<task>"`，
而 Hermes 带着终端、文件、SSH、浏览器等全部工具。这不是只读通道，请按这个前提做隔离。

## 威胁模型

| 威胁 | 影响 | 缓解 |
|---|---|---|
| token 泄露（截图、备份、同步盘、日志） | 别人可以让你的机器执行任意任务 | 一 client 一 token；按用途拆分；发现即吊销；token 只放 `600` 文件 |
| 手机丢失 | 同上（手机上有 token 和模型 key） | 手机 token 单独一把，随时从 relay 配置里删 |
| relay 被入侵 | 可切断、可伪造消息 | relay 只存 token 哈希/原值，不存业务内容；定期轮换 |
| 中间人 | 窃听/篡改 | 全程 HTTPS；不校验证书的「容器里缺 CA 就跳过」开关只在受控内网用 |
| 误配置 | 把内网 webhook/端口暴露到公网 | 跨机一律走 relay 出站，不开入站端口 |

## 凭据放哪

| 凭据 | 位置 | 权限 |
|---|---|---|
| relay token | `~/.dsh/hermes-bridge.json`、`~/.hermes/relay/client_*.json` | `600` |
| 模型 key | 同上（`deepseek_api_key`）或环境变量 | `600` |
| webhook HMAC secret | Hermes 的订阅配置，插件自动读取 | 随宿主 |

仓库里**只有** `.example` 文件，任何真实 token/key 都不入库。发布前跑一遍：

```sh
python3 tools/scan_secrets.py .          # 扫工作树
python3 tools/scan_secrets.py --history .  # 扫 git 历史
```

## 部署建议

1. relay 单独一台机器，只跑 relay，不放业务代码
2. client 划分：`server-exec`（执行器）、`server-call`（发起端）、`phone`（手机）各一把 token
3. 手机端只做「接收 + 执行 + 回投」，不需要任何公网入口
4. 执行器用 systemd 用户单元跑，`Restart=always`，日志落 `~/.hermes/logs/`
5. 定期看日志里的任务来源与耗时；异常调用量是最好的入侵信号

## 数据边界

- 发出去的是**任务文本**，返回的是**答复文本**；文件不经这条通道传输
- relay 侧能看到任务与答复明文（它只是中转，不做端到端加密）；敏感内容自行判断是否适合过 relay
- 执行器的答复超过 8000 字符会被头尾截断，别用它传大块数据

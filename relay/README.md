# relay/ — Hermes 侧

| 文件 | 用途 |
|---|---|
| `hermes_exec_relay.py` | 执行器：订阅 relay，收到 `call_hermes` 就跑 `hermes -z`，回投结果 |
| `dsh_phone.py` | 发起端：从 Hermes 这边给 DSH（手机/远程）派任务并等结果 |
| `hermes-exec-relay.service` | systemd 用户单元 |
| `client.example.json` | 配置模板（`relay_url` / `client_id` / `token`） |

## 安装执行器

```sh
mkdir -p ~/.hermes/relay ~/.hermes/logs
cp hermes_exec_relay.py ~/.hermes/relay/
cp client.example.json ~/.hermes/relay/client_server_exec.json
chmod 600 ~/.hermes/relay/client_server_exec.json
$EDITOR ~/.hermes/relay/client_server_exec.json      # relay_url / client_id / token
```

没装成服务也能先跑起来验证：

```sh
python3 ~/.hermes/relay/hermes_exec_relay.py
# [boot] hermes=… timeout=600s
# [sse] connected
```

## 装成用户服务

`hermes-exec-relay.service` 里的 `/home/<user>` 改成你的真实路径，然后：

```sh
cp hermes-exec-relay.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now hermes-exec-relay
journalctl --user -u hermes-exec-relay -f
```

## 派任务给 DSH

```sh
# 等结果（默认 900s）
python3 ~/.hermes/relay/dsh_phone.py "看一眼电量，只回百分比"

# 自定义超时
python3 ~/.hermes/relay/dsh_phone.py "跑一下 ./collect.sh" --timeout 1800

# 不等结果（投递即返回）
python3 ~/.hermes/relay/dsh_phone.py "后台跑一次备份" --no-wait
```

退出码：`0` 成功，`1` 对端返回失败，`2` 投递/等待失败。

## 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `HERMES_BIN` | `~/.local/bin/hermes` | Hermes 可执行文件 |
| `HERMES_TIMEOUT` | `600` | 单任务默认超时（秒） |
| `HERMES_WEBHOOK_BASE` | `http://127.0.0.1:8644` | 回执推送用的本机 webhook 前缀 |

## 日志

`~/.hermes/logs/exec-relay.log`，每条任务一行：

```
[job] id=9bc070b5 from=phone len=10
[job] id=9bc070b5 ok=True 11s chars=3 sent=True
```

`chars` 是答复长度，`ms` 是耗时；`sent=False` 说明回投失败（对端掉线 / token 失效）。

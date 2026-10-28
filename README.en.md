# hermes-bridge

**Let two AI agents hand work to each other: DeepSeek Harness (DSH) ↔ Hermes Agent.**

One agent on your desktop that can run a shell and SSH into servers. Another one on your phone,
always within reach. This project connects them so each can act as the other's executor:

- Ask from the phone, DSH forwards the task to Hermes on the desktop, the answer comes back
- From the desktop, dispatch a task to the phone (screen, files, scripts) and collect the result
- Works across NAT: a small relay on a public host forwards messages; both sides only make outbound connections

```
┌──────────── phone / remote DSH ─────────────┐   ┌──────────── your host ─────────────┐
│  call_hermes tool                           │   │  relay executor (Python)           │
│    └─ relay.js ──┐                          │   │    └─ runs `hermes -z`             │
│  phone-agent ◄───┼── tasks / results        │   │       (full Hermes toolset)        │
└──────────────────┼──────────────────────────┘   └───────────────┬────────────────────┘
                   │                                              │
             ┌─────▼──────────────────────────────────────────────▼─────┐
             │        public relay (HTTP + SSE, per-client routing)     │
             └──────────────────────────────────────────────────────────┘
```

Same-machine use needs no relay: the plugin falls back to `execFile(hermes)`.

## Layout

| Path | What |
|---|---|
| `plugin/` | DSH plugin bundle: `hermes-bridge` (call_hermes tool), `phone-agent` (remote executor) |
| `relay/` | Hermes side: executor `hermes_exec_relay.py`, caller `dsh_phone.py`, systemd unit |
| `docs/` | architecture, protocol, security |
| `tools/scan_secrets.py` | pre-publish scan for keys, private hosts, personal paths |

Branch `hd` adds: `hd-events` (session stall monitoring for a local DSH), ACP clients, HD integration notes.

## Quick start

```sh
# 1. Hermes host: run the executor
mkdir -p ~/.hermes/relay ~/.hermes/logs
cp relay/hermes_exec_relay.py ~/.hermes/relay/
cp relay/client.example.json ~/.hermes/relay/client_server_exec.json   # fill relay_url/token
chmod 600 ~/.hermes/relay/client_server_exec.json
cp relay/hermes-exec-relay.service ~/.config/systemd/user/            # fix paths first
systemctl --user daemon-reload && systemctl --user enable --now hermes-exec-relay

# 2. DSH side: install + configure
dsh plugin --profile <profile> add /path/to/plugin
cp plugin/hermes-bridge.example.json ~/.dsh/hermes-bridge.json
chmod 600 ~/.dsh/hermes-bridge.json

# 3. Verify both directions
#    in DSH:      call_hermes(task: "reply with exactly: ok")
#    on Hermes:   python3 ~/.hermes/relay/dsh_phone.py "reply with exactly: got it"
```

## Protocol (summary)

| Message | Direction | Shape |
|---|---|---|
| call | caller → executor | `{"kind":"call_hermes","id","task","timeout_s"}` |
| result | executor → caller | `{"kind":"result","id","ok","text","elapsed_ms"}` |
| dispatch | host → phone | `{"kind":"exec","id","task"}` |
| phone result | phone → host | `{"kind":"exec_result","id","ok","text"}` |
| heartbeat | both | `{"kind":"ping"}` / `{"kind":"pong"}` |

Relay: `GET /health`, `GET /clients`, `POST /send`, `GET /events` (SSE). See `docs/protocol.md`.

## Security

- **One token per client**, split by role (executor / caller / phone); revoke any one independently
- Tokens and model keys live only in local `600` files; the repo ships `.example` files only
- Cross-machine pushes go through the relay, so no inbound ports on the phone or LAN side
- Anyone holding a relay token can run tasks with Hermes' full toolset — isolate accordingly

Details in `docs/security.md`.

## License

MIT

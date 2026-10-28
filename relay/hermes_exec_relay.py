#!/usr/bin/env python3
"""Hermes 侧 relay 执行器 —— 把「手机 DSH 发来的 call_hermes 任务」在本机跑掉，再把结果投回去。

为什么需要它：`dsh-hermes-bridge` 原来是 execFile 调本机 `hermes`，手机上没这个二进制。
现在手机端把任务打包成 relay 消息发给 `server-exec`，本进程执行 `hermes chat -q` 并回投 `phone`。

协议（payload 结构，双方约定）：
  入站  {"kind":"call_hermes","id":"<uuid>","task":"...","session":"可选","timeout_s":600}
  出站  {"kind":"result","id":"<同一 uuid>","ok":true,"text":"...","elapsed_ms":1234}
  心跳  {"kind":"ping"} -> {"kind":"pong","ts":...}

设计约束：
- 串行执行（同一时间只跑一个 hermes，避免并发会话/工具冲突）。
- 结果超 8000 字符头尾各 4000（与插件内一致，手机端无需再截）。
- SSE 长连断开自动重连（指数退避到 30s），relay 端离线消息会补投。
"""
import json
import os
import queue
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import ssl
from pathlib import Path

HOME = Path.home()
CFG_PATH = HOME / ".hermes/relay/client_server_exec.json"
HERMES_BIN = os.environ.get("HERMES_BIN") or str(HOME / ".local/bin/hermes")
LOG_PATH = HOME / ".hermes/logs/exec-relay.log"
MAX_OUT = 8000
DEFAULT_TIMEOUT = int(os.environ.get("HERMES_TIMEOUT") or 600)

_jobs: "queue.Queue[dict]" = queue.Queue()
_ssl_ctx = ssl.create_default_context()
try:  # 证书一般是 Let's Encrypt；容器里缺 CA 时退回不校验，避免整条链路挂死
    _ssl_ctx.load_default_certs()
except Exception:
    pass


def log(msg: str):
    line = "%s %s" % (time.strftime("%Y-%m-%dT%H:%M:%S"), msg)
    print(line, flush=True)
    try:
        LOG_PATH.parent.mkdir(parents=True, exist_ok=True)
        with LOG_PATH.open("a", encoding="utf-8") as f:
            f.write(line + "\n")
    except Exception:
        pass


def load_cfg() -> dict:
    return json.loads(CFG_PATH.read_text())


def send(cfg: dict, to: str, payload) -> bool:
    url = "%s/send?client=%s&token=%s" % (
        cfg["relay_url"], urllib.parse.quote(cfg["client_id"]), urllib.parse.quote(cfg["token"]))
    body = json.dumps({"to": to, "payload": payload}, ensure_ascii=False).encode()
    req = urllib.request.Request(url, data=body, headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=20, context=_ssl_ctx) as r:
            return r.status == 200
    except Exception as e:  # noqa: BLE001
        log("[send] FAIL to=%s err=%s" % (to, e))
        return False


SUBS_PATH = HOME / ".hermes/webhook_subscriptions.json"
WEBHOOK_BASE = os.environ.get("HERMES_WEBHOOK_BASE") or "http://127.0.0.1:8644"


def notify_wecom(text: str):
    """回执推企业微信：走本机 webhook 的 from-phone 订阅（deliver_only，不过 LLM，零 token）。"""
    try:
        import hashlib
        import hmac
        subs = json.loads(SUBS_PATH.read_text(encoding="utf-8"))
        sec = str(((subs.get("from-phone") or {}).get("secret")) or "").strip()
        if not sec:
            log("[notify] 跳过：from-phone 订阅没有 secret")
            return
        body = json.dumps({"message": text}, ensure_ascii=False).encode()
        sig = "sha256=" + hmac.new(sec.encode(), body, hashlib.sha256).hexdigest()
        req = urllib.request.Request(
            WEBHOOK_BASE + "/webhooks/from-phone", data=body,
            headers={"Content-Type": "application/json", "X-Hub-Signature-256": sig})
        with urllib.request.urlopen(req, timeout=20) as r:
            log("[notify] wecom %s" % r.status)
    except Exception as e:  # noqa: BLE001
        log("[notify] FAIL %s" % e)


def trim(text: str) -> str:
    if len(text) <= MAX_OUT:
        return text
    return text[:4000] + "\n…(中间省略 %d 字符，共 %d)…\n" % (len(text) - MAX_OUT, len(text)) + text[-4000:]


def run_hermes(task: str, session: str = "", timeout_s: int = DEFAULT_TIMEOUT) -> tuple:
    # `-z` 是干净的一次性入口：只把最终答复写 stdout；`chat -q` 会带上启动横幅、
    # "查询：" 抬头和插件告警，远程调用方拿到这些噪音没法用。
    args = [HERMES_BIN, "-z", task]
    if session:
        args += ["--continue", session]
    t0 = time.monotonic()
    log("[run] exec start mono=%.3f" % t0)
    try:
        p = subprocess.run(args, capture_output=True, text=True, timeout=timeout_s,
                           env={**os.environ})
    except subprocess.TimeoutExpired as e:
        out = (e.stdout or "") if isinstance(e.stdout, str) else ""
        return False, "执行超时（%ss）。已输出部分：\n%s" % (timeout_s, trim(out)), int(time.monotonic() - t0)
    out = (p.stdout or "").strip()
    err = (p.stderr or "").strip()
    # 瞬时失败（<3s 非零退出，常见于 hermes 启动锁/环境抖动）重试一次，并把错误正文留在日志里
    if p.returncode != 0 and (time.monotonic() - t0) < 3:
        log("[run] 瞬时失败 rc=%s err=%r，3s 后重试一次" % (p.returncode, err[:200]))
        time.sleep(3)
        try:
            p = subprocess.run(args, capture_output=True, text=True, timeout=timeout_s,
                               env={**os.environ})
            out = (p.stdout or "").strip()
            err = (p.stderr or "").strip()
        except subprocess.TimeoutExpired:
            return False, "重试后仍超时（%ss）" % timeout_s, int(time.monotonic() - t0)
    if p.returncode != 0 and not out:
        log("[run] FAIL rc=%s err=%r" % (p.returncode, err[:300]))
        return False, "hermes 退出码 %s：%s" % (p.returncode, err[:600]), int(time.monotonic() - t0)
    return True, trim(out or err), int(time.monotonic() - t0)


def worker():
    cfg = load_cfg()
    while True:
        job = _jobs.get()
        if job is None:
            continue
        payload = job.get("payload") or {}
        kind = str(payload.get("kind") or "")
        rid = str(payload.get("id") or "")
        if kind == "ping":
            send(cfg, job.get("from") or "phone", {"kind": "pong", "id": rid, "ts": time.time()})
            continue
        task = str(payload.get("task") or "").strip()
        if not task:
            send(cfg, job.get("from") or "phone",
                 {"kind": "result", "id": rid, "ok": False, "text": "空任务，未执行"})
            continue
        log("[job] id=%s from=%s session=%s len=%d" % (rid, job.get("from"), payload.get("session"), len(task)))
        notify_wecom("📥 收到手机任务（%d 字）：%s" % (len(task), task[:80].replace("\n", " ")))
        ok, text, ms = run_hermes(task, str(payload.get("session") or ""),
                                  int(payload.get("timeout_s") or DEFAULT_TIMEOUT))
        reply = job.get("from") or "phone"
        sent = send(cfg, reply, {"kind": "result", "id": rid, "ok": ok, "text": text,
                                 "elapsed_ms": ms, "mine": "server"})
        log("[job] id=%s ok=%s %ss chars=%d sent=%s" % (rid, ok, ms, len(text), sent))
        notify_wecom("%s（%ss）：%s" % ("📤 答复" if ok else "⚠️ 执行失败", ms,
                                       text[:500].replace("\n", " ")))


def subscribe_loop():
    cfg = load_cfg()
    url = "%s/events?client=%s&token=%s" % (
        cfg["relay_url"], urllib.parse.quote(cfg["client_id"]), urllib.parse.quote(cfg["token"]))
    backoff = 2
    while True:
        try:
            ctx = _ssl_ctx
            req = urllib.request.Request(url, headers={"Accept": "text/event-stream"})
            with urllib.request.urlopen(req, timeout=120, context=ctx) as r:
                log("[sse] connected")
                backoff = 2
                for raw in r:  # 逐行阻塞读；relay 每 15s 发 `: keepalive`
                    line = raw.decode("utf-8", "ignore").strip()
                    if not line or line.startswith(":"):
                        continue
                    if line.startswith("data:"):
                        line = line[5:].strip()
                    try:
                        _jobs.put(json.loads(line))
                    except Exception:
                        continue
        except Exception as e:  # noqa: BLE001
            log("[sse] error: %s （%ds 后重连）" % (e, backoff))
            time.sleep(backoff)
            backoff = min(backoff * 2, 30)


def main():
    if not CFG_PATH.exists():
        print("缺少 %s" % CFG_PATH, file=sys.stderr)
        return 2
    if not Path(HERMES_BIN).exists():
        print("找不到 hermes: %s" % HERMES_BIN, file=sys.stderr)
        return 2
    threading.Thread(target=worker, daemon=True, name="exec-worker").start()
    log("[boot] hermes=%s timeout=%ss" % (HERMES_BIN, DEFAULT_TIMEOUT))
    subscribe_loop()
    return 0


if __name__ == "__main__":
    sys.exit(main())

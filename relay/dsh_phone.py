#!/usr/bin/env python3
"""dsh_phone — 从本机把任务交给手机上的 DSH 跑，并把结果取回来。

方向 B（Hermes → 手机 DSH）的本机客户端。手机端由 `phone-agent` 插件接收：
它跑 `dsh headless "<task>"`，结果回投给本进程，同时（如果配了 webhook）推 IM。

用法：
  dsh_phone.py "把手机屏幕截图存到 /sdcard/Download 并读一下电量"
  dsh_phone.py --timeout 1800 --no-wait "长任务，不等结果"

退出码：0 成功；1 对端报错；2 超时/链路问题。
"""
import argparse
import json
import ssl
import sys
import time
import urllib.parse
import urllib.request
import uuid
from pathlib import Path

HOME = Path.home()
CFG = HOME / ".hermes/relay/client_server_call.json"
CTX = ssl.create_default_context()


def send(cfg, to, payload):
    url = "%s/send?client=%s&token=%s" % (
        cfg["relay_url"], urllib.parse.quote(cfg["client_id"]), urllib.parse.quote(cfg["token"]))
    body = json.dumps({"to": to, "payload": payload}, ensure_ascii=False).encode()
    req = urllib.request.Request(url, data=body, headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=20, context=CTX) as r:
        return r.status == 200


def wait_result(cfg, rid, timeout_s):
    url = "%s/events?client=%s&token=%s" % (
        cfg["relay_url"], urllib.parse.quote(cfg["client_id"]), urllib.parse.quote(cfg["token"]))
    req = urllib.request.Request(url, headers={"Accept": "text/event-stream"})
    deadline = time.time() + timeout_s
    with urllib.request.urlopen(req, timeout=timeout_s + 30, context=CTX) as r:
        for raw in r:
            if time.time() > deadline:
                return None
            line = raw.decode("utf-8", "ignore").strip()
            if not line or line.startswith(":"):
                continue
            if line.startswith("data:"):
                line = line[5:].strip()
            try:
                msg = json.loads(line)
            except Exception:
                continue
            p = msg.get("payload") or {}
            if p.get("kind") in ("exec_result", "result") and str(p.get("id")) == rid:
                return p
    return None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("task")
    ap.add_argument("--timeout", type=int, default=900)
    ap.add_argument("--no-wait", action="store_true")
    ap.add_argument("--to", default="phone")
    a = ap.parse_args()

    cfg = json.loads(CFG.read_text())
    rid = uuid.uuid4().hex[:12]
    if not send(cfg, a.to, {"kind": "exec", "id": rid, "task": a.task, "timeout_s": a.timeout}):
        print("发送失败", file=sys.stderr)
        return 2
    if a.no_wait:
        print("已投递给 %s（id=%s，不等结果）" % (a.to, rid))
        return 0
    print("已投递给 %s，等结果（最多 %ss）…" % (a.to, a.timeout), file=sys.stderr)
    res = wait_result(cfg, rid, a.timeout + 120)
    if res is None:
        print("等结果超时/链路中断（id=%s）" % rid, file=sys.stderr)
        return 2
    text = str(res.get("text") or "").strip()
    print(text or "(空输出)")
    return 0 if res.get("ok") else 1


if __name__ == "__main__":
    sys.exit(main())

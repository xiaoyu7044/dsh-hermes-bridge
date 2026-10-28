#!/usr/bin/env python3
"""发布前自检：扫密钥、私有地址、个人路径。

用法：
    python3 tools/scan_secrets.py .             # 只扫工作树
    python3 tools/scan_secrets.py --history .   # 连 git 历史一起扫

退出码 0 = 干净，1 = 有命中（CI 里直接红）。
规则刻意写得宽，宁可误报也别漏报；确属误报就加进 ALLOW 注释或用 --exclude。
"""
from __future__ import annotations

import re
import subprocess
import sys
from pathlib import Path

SKIP_DIRS = {".git", "node_modules", "venv", "__pycache__", "dist", "build"}
SKIP_SUFFIX = {".png", ".jpg", ".jpeg", ".gif", ".ico", ".woff", ".woff2", ".tgz", ".zip", ".pdf"}

PATTERNS = [
    ("API key (sk-)", re.compile(r"sk-[A-Za-z0-9_\-]{16,}")),
    ("AWS/GCP key", re.compile(r"(AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_\-]{35})")),
    ("private key block", re.compile(r"-----BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY-----")),
    ("long hex token", re.compile(r"\b[0-9a-f]{40,}\b")),
    ("personal home path", re.compile(r"/(home|Users)/[A-Za-z0-9._-]+/")),
    ("private IPv4", re.compile(r"\b(10\.\d{1,3}|192\.168\.\d{1,3}|172\.(1[6-9]|2\d|3[01]))\.\d{1,3}\.\d{1,3}\b")),
    ("token/secret literal", re.compile(r"(?i)\b(token|secret|password|passwd|api_?key)\b\s*[:=]\s*[\"'][^\"'<>\s]{8,}[\"']")),
    ("bearer header", re.compile(r"(?i)authorization\s*:\s*bearer\s+[A-Za-z0-9._\-]{12,}")),
    ("webhook url with secret", re.compile(r"https?://[^\s\"']*/(webhooks?|hooks?)/[A-Za-z0-9_\-]{8,}")),
]

# 允许出现在文档里的占位写法
ALLOW = re.compile(r"<[^>]+>|\bexample\.com\b|\bEXAMPLE\b|xxx+|\*\*\*|REDACTED", re.I)


def scan_text(name: str, text: str) -> list[str]:
    hits = []
    for lineno, line in enumerate(text.splitlines(), 1):
        if ALLOW.search(line) and not re.search(r"sk-[A-Za-z0-9_\-]{16,}", line):
            continue
        for label, rx in PATTERNS:
            m = rx.search(line)
            if not m:
                continue
            # 本机回环地址的 webhook 路径不是密钥（测试断言、文档示例常见）
            if label.startswith("webhook url") and re.search(r"://(127\.0\.0\.1|localhost|\[::1\])\b", line):
                continue
            hits.append(f"{name}:{lineno}: {label}: {line.strip()[:120]}")
    return hits


def scan_tree(root: Path) -> list[str]:
    hits = []
    for p in sorted(root.rglob("*")):
        if not p.is_file() or p.suffix.lower() in SKIP_SUFFIX:
            continue
        if any(part in SKIP_DIRS for part in p.parts):
            continue
        try:
            text = p.read_text(encoding="utf-8")
        except (UnicodeDecodeError, OSError):
            continue
        hits += scan_text(str(p.relative_to(root)), text)
    return hits


def scan_history(root: Path) -> list[str]:
    try:
        revs = subprocess.run(["git", "-C", str(root), "rev-list", "--all"],
                              capture_output=True, text=True, check=True).stdout.split()
    except (subprocess.CalledProcessError, FileNotFoundError):
        return ["git: 无法读取历史（跳过）"]
    hits = []
    for rev in revs:
        files = subprocess.run(["git", "-C", str(root), "ls-tree", "-r", "--name-only", rev],
                               capture_output=True, text=True).stdout.splitlines()
        for f in files:
            if Path(f).suffix.lower() in SKIP_SUFFIX:
                continue
            blob = subprocess.run(["git", "-C", str(root), "show", f"{rev}:{f}"],
                                  capture_output=True, text=True)
            if blob.returncode != 0:
                continue
            hits += [f"{rev[:8]}:{h}" for h in scan_text(f, blob.stdout)]
    return hits


def main() -> int:
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    root = Path(args[0] if args else ".").resolve()
    hits = scan_tree(root)
    if "--history" in sys.argv:
        hits += scan_history(root)
    if hits:
        print("\n".join(hits))
        print(f"\n✗ {len(hits)} 处命中，先处理再发布")
        return 1
    print(f"✓ {root} 未发现密钥/私有地址/个人路径")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

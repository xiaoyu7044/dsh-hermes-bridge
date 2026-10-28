#!/usr/bin/env bash
# release.sh — 一键发布 dsh-hermes-bridge（含自检、npm 发布、双分支同步）
#
# 用法：
#   tools/release.sh patch            # 0.6.1 → 0.6.2
#   tools/release.sh minor            # 0.6.1 → 0.7.0
#   tools/release.sh major            # 0.6.1 → 1.0.0
#   tools/release.sh 1.2.3            # 指定版本
#   tools/release.sh patch --dry-run  # 只跑检查，不改任何东西
#
# 选项：
#   --dry-run      自检 + 打印计划，不提交/不发布
#   --skip-verify  跳过 npm 传播等待与安装复验（不建议）
#   --no-hd-sync   不同步 hd 分支
#   --allow-dirty  允许工作区有未提交改动（仅调试用）
#
# 设计前提：main 是唯一发布线，hd 与 main 内容保持一致。
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
PKG_DIR="$ROOT/plugin"
PKG_NAME="dsh-hermes-bridge"
BRANCH="main"
HD_BRANCH="hd"

DRY_RUN=0
SKIP_VERIFY=0
HD_SYNC=1
ALLOW_DIRTY=0
BUMP=""

for arg in "$@"; do
    case "$arg" in
        --dry-run) DRY_RUN=1 ;;
        --skip-verify) SKIP_VERIFY=1 ;;
        --no-hd-sync) HD_SYNC=0 ;;
        --allow-dirty) ALLOW_DIRTY=1 ;;
        -h|--help) sed -n '2,25p' "${BASH_SOURCE[0]}"; exit 0 ;;
        -*) echo "未知选项: $arg" >&2; exit 2 ;;
        *) BUMP="$arg" ;;
    esac
done

if [ -z "$BUMP" ]; then
    echo "用法: tools/release.sh patch|minor|major|<x.y.z> [--dry-run]" >&2
    exit 2
fi

step() { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }
ok()   { printf '  \033[32m✓\033[0m %s\n' "$*"; }
warn() { printf '  \033[33m!\033[0m %s\n' "$*"; }
die()  { printf '\n\033[31m✗ %s\033[0m\n' "$*" >&2; exit 1; }

# ---------------------------------------------------------------- 1. 前置检查
step "前置检查"

command -v node >/dev/null || die "缺 node"
command -v python3 >/dev/null || die "缺 python3"
command -v npm >/dev/null || die "缺 npm"
git rev-parse --git-dir >/dev/null 2>&1 || die "$ROOT 不是 git 仓库"

CUR_BRANCH="$(git branch --show-current)"
[ "$CUR_BRANCH" = "$BRANCH" ] || die "当前分支是 $CUR_BRANCH，发布必须在 $BRANCH 上"
ok "分支 $BRANCH"

if [ "$ALLOW_DIRTY" -eq 0 ] && [ -n "$(git status --porcelain)" ]; then
    git status --short
    die "工作区不干净，先提交或 stash（调试可加 --allow-dirty）"
fi
ok "工作区干净"

NPM_USER="$(npm whoami 2>/dev/null || true)"
[ -n "$NPM_USER" ] || die "npm 未登录（npm login）"
ok "npm 身份 $NPM_USER"

git fetch -q origin "$BRANCH"
LOCAL="$(git rev-parse HEAD)"
REMOTE="$(git rev-parse "origin/$BRANCH" 2>/dev/null || echo '')"
[ "$LOCAL" = "$REMOTE" ] || die "本地 $BRANCH 与 origin/$BRANCH 不一致，先 pull/push"
ok "与远端同步（${LOCAL:0:7}）"

OLD_VER="$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["version"])' "$PKG_DIR/package.json")"
NEW_VER="$(python3 - "$OLD_VER" "$BUMP" <<'PY'
import sys, re
old, bump = sys.argv[1], sys.argv[2]
if re.fullmatch(r'\d+\.\d+\.\d+', bump):
    print(bump); raise SystemExit
major, minor, patch = (int(x) for x in old.split('.'))
if bump == 'major':   major, minor, patch = major + 1, 0, 0
elif bump == 'minor': minor, patch = minor + 1, 0
elif bump == 'patch': patch += 1
else:
    sys.exit(f"无法识别的版本参数: {bump}")
print(f"{major}.{minor}.{patch}")
PY
)" || die "版本号计算失败"
ok "版本 $OLD_VER → $NEW_VER"

if npm view "$PKG_NAME@$NEW_VER" version >/dev/null 2>&1; then
    die "npm 上已有 $PKG_NAME@$NEW_VER，换个版本号"
fi
ok "npm 上没有 $NEW_VER"

# ---------------------------------------------------------------- 2. 代码自检
step "自检"

fail=0

while IFS= read -r f; do
    node --check "$f" >/dev/null 2>&1 || { echo "  语法错误: $f"; fail=1; }
done < <(find . -name '*.js' -o -name '*.mjs' | grep -v -e '^./node_modules' -e '^./.git')
[ "$fail" -eq 0 ] && ok "JS 语法" || die "JS 语法检查失败"

python3 -m compileall -q relay tools clients >/dev/null || die "Python 编译失败"
ok "Python 编译"

python3 - <<'PY' || die "JSON 解析失败"
import json, pathlib, sys
bad = []
for p in pathlib.Path('.').rglob('*.json'):
    if '.git' in p.parts or 'node_modules' in p.parts:
        continue
    try:
        json.loads(p.read_text())
    except Exception as e:
        bad.append(f"{p}: {e}")
if bad:
    print("\n".join(bad)); sys.exit(1)
PY
ok "JSON 合法"

if ls plugin/test/*.test.mjs >/dev/null 2>&1; then
    node --test plugin/test/*.test.mjs 2>&1 | grep -E '^# (pass|fail)' | sed 's/^/  /'
    node --test plugin/test/*.test.mjs >/dev/null 2>&1 || die "插件单测失败"
    ok "插件单测"
fi

python3 tools/scan_secrets.py . --history >/dev/null || {
    python3 tools/scan_secrets.py . --history | tail -20
    die "密钥扫描有命中"
}
ok "密钥扫描（工作树 + 历史）"

# ---------------------------------------------------------------- 3. 计划
step "发布计划"
cat <<EOF
  版本      : $OLD_VER → $NEW_VER
  tag       : v$NEW_VER
  分支      : $BRANCH$( [ "$HD_SYNC" -eq 1 ] && echo " + $HD_BRANCH 同步" )
  包        : $PKG_NAME@$NEW_VER
  动作      : 改版本 → 提交 → tag → push → npm publish$(
    [ "$SKIP_VERIFY" -eq 0 ] && echo " → 等传播 → 拉 tarball 复验$(command -v dsh >/dev/null && echo ' → 沙箱安装复验')" || echo ''
)
EOF

if [ "$DRY_RUN" -eq 1 ]; then
    printf '\n\033[33m--dry-run：未做任何改动\033[0m\n'
    exit 0
fi

# ---------------------------------------------------------------- 4. 改版本 + 提交
step "改版本并提交"

python3 - "$PKG_DIR/package.json" "$NEW_VER" <<'PY'
import json, sys, pathlib
p = pathlib.Path(sys.argv[1]); d = json.loads(p.read_text())
d["version"] = sys.argv[2]
p.write_text(json.dumps(d, ensure_ascii=False, indent=2) + "\n")
PY
ok "package.json → $NEW_VER"

git add -A
git -c user.name="${GIT_AUTHOR_NAME:-hermes-bridge}" \
    -c user.email="${GIT_AUTHOR_EMAIL:-dev@example.com}" \
    commit -q -m "release: $NEW_VER"
git tag -a "v$NEW_VER" -m "v$NEW_VER"
ok "提交 $(git rev-parse --short HEAD) 与 tag v$NEW_VER"

# ---------------------------------------------------------------- 5. 推代码
step "推送 $BRANCH"
git push -q origin "$BRANCH"
git push -q origin "v$NEW_VER"
ok "origin/$BRANCH 与 tag 已推"

# ---------------------------------------------------------------- 6. 发布 npm
step "npm publish"
( cd "$PKG_DIR" && npm publish --access public 2>&1 | tail -3 )
ok "已提交到 registry"

# ---------------------------------------------------------------- 7. 复验
if [ "$SKIP_VERIFY" -eq 0 ]; then
    step "等待 registry 传播（最多 10 分钟）"
    for i in $(seq 1 20); do
        V="$(npm view "$PKG_NAME" version 2>/dev/null || true)"
        if [ "$V" = "$NEW_VER" ]; then
            ok "latest = $V（${i}0s 内生效）"
            break
        fi
        printf '  … latest=%s（%ss）\n' "${V:-未知}" "$((i*30))"
        [ "$i" -eq 20 ] && die "10 分钟仍未传播，稍后手动核对：npm view $PKG_NAME version"
        sleep 30
    done

    step "复验 tarball"
    TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
    URL="$(npm view "$PKG_NAME@$NEW_VER" dist.tarball | tr -d "'")"
    curl -fsSL "$URL" -o "$TMP/p.tgz" || die "下载 tarball 失败"
    tar tzf "$TMP/p.tgz" | sed 's/^/  /'
    tar xzf "$TMP/p.tgz" -C "$TMP"
    [ "$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["version"])' "$TMP/package/package.json")" = "$NEW_VER" ] \
        || die "tarball 内版本号不对"
    for f in hermes-bridge.js relay.js phone-agent.js hd-events.js cordis.patch.yml package.json; do
        [ -f "$TMP/package/$f" ] || die "tarball 缺 $f"
    done
    ok "tarball 内容完整"

    if command -v dsh >/dev/null 2>&1; then
        step "沙箱安装复验"
        SB="$(mktemp -d)"
        DSH_HOME="$SB" dsh plugin --profile web add "$PKG_NAME@$NEW_VER" >/dev/null 2>&1 \
            || die "沙箱安装失败（pnpm minimumReleaseAge 会挑旧版，务必带 @版本）"
        INST="$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["version"])' \
            "$SB/profiles/web/node_modules/$PKG_NAME/package.json")"
        [ "$INST" = "$NEW_VER" ] || die "沙箱里装成了 $INST"
        N="$(DSH_HOME="$SB" dsh --profile web --dump-config 2>/dev/null | grep -c "name: $PKG_NAME" || true)"
        [ "$N" = "3" ] || warn "注册插件数 $N（预期 3：hermes-bridge / hd-events / phone-agent）"
        ok "沙箱安装 $INST，注册 $N 个插件"
        rm -rf "$SB"
    else
        warn "未找到 dsh，跳过沙箱安装复验"
    fi
fi

# ---------------------------------------------------------------- 8. 同步 hd
if [ "$HD_SYNC" -eq 1 ]; then
    step "同步 $HD_BRANCH"
    git checkout -q "$HD_BRANCH"
    git merge --no-ff "$BRANCH" -m "chore: $HD_BRANCH 分支同步 $BRANCH（$NEW_VER）" >/dev/null
    git push -q origin "$HD_BRANCH"
    git checkout -q "$BRANCH"
    ok "$HD_BRANCH 已同步并推送"
fi

step "完成"
printf '  %s@%s 已发布\n  https://www.npmjs.com/package/%s\n' "$PKG_NAME" "$NEW_VER" "$PKG_NAME"

// @ts-nocheck — 独立插件，运行时由 DSH 的 tsx 解析
/**
 * hd-events — HD（本机 DeepSeek Harness）会话事件监控。
 *
 * 只看真实活跃信号：`~/.dsh/sessions/` 下的会话文件（HD 干活时持续写入）。
 *   有写入           → 在干活
 *   曾经活跃，N 分钟无写入 → 疑似卡住（HD_STALL_MIN，默认 20）
 *   从停滞又恢复活跃  → 推 hd_resumed，用户知道它自己缓过来了
 * 纯空闲（从未活跃）永不报停滞——空闲不等于卡住。
 *
 * 事件怎么出去（按可用性自动选，先 webhook 后 relay）：
 *   1. Hermes webhook：POST + X-Hub-Signature-256（HMAC-SHA256，订阅专属 secret），零 LLM 成本
 *   2. relay：走 hermes-bridge 的 relay 链路发一条 notify，远端 Hermes 转投 IM
 *   3. 都没有：只写日志
 *
 * 配置：
 *   DSH_HOME             默认 ~/.dsh
 *   HD_SESSIONS_DIR      默认 $DSH_HOME/sessions
 *   HD_STALL_MIN         停滞阈值（分钟，默认 20；0 关闭停滞告警）
 *   HD_HEARTBEAT_MIN     心跳间隔（分钟，默认 0 关闭）
 *   HD_EVENT_URL / HD_EVENT_SECRET   显式指定 webhook（不给就自动从订阅文件找）
 *   HERMES_HOME          默认 ~/.hermes（找 webhook_subscriptions.json）
 */
import { watch, readFileSync, writeFileSync, existsSync, unlinkSync, statSync, readdirSync } from 'node:fs';
import { createHmac } from 'node:crypto';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { getLink } from './relay.js';

export const name = 'hd-events';

const DSH_HOME = process.env.DSH_HOME || join(homedir(), '.dsh');
const SESSIONS_ROOT = process.env.HD_SESSIONS_DIR || join(DSH_HOME, 'sessions');
const STALL_MIN = Number(process.env.HD_STALL_MIN ?? 20);
const HEARTBEAT_MIN = Number(process.env.HD_HEARTBEAT_MIN ?? 0);
// 按用户分锁：同一台机器上多个账号/多个 profile 各自一份，不互相挡
const LOCK = join(tmpdir(), 'hd-events-' + (typeof process.getuid === 'function' ? process.getuid() : 0) + '.lock');

/**
 * 从 Hermes 的订阅文件里取某条订阅的 url/secret。
 * 真实文件有三种形状，都要认：
 *   {"hd-events": {"url": "…", "secret": "…"}}      ← Hermes 实际写的
 *   {"subscriptions": [{name: "hd-events", …}]}
 *   [{name: "hd-events", …}]
 * 旧实现只认后两种，遇到第一种会静默拿到空 secret → HMAC 校验失败 → 401。
 */
export function findSubscription(raw, subName = 'hd-events') {
    if (!raw)
        return null;
    if (Array.isArray(raw))
        return raw.find((s) => s && s.name === subName) || null;
    if (Array.isArray(raw.subscriptions))
        return raw.subscriptions.find((s) => s && s.name === subName) || null;
    const direct = raw[subName];
    if (direct && typeof direct === 'object')
        return { name: subName, ...direct };
    return null;
}

/** 递归扫 sessions 根，返回所有会话文件的最大 mtime（毫秒；没有则 0） */
export function scanLatestMtime(dir, depth = 0) {
    if (depth > 4)
        return 0;
    let latest = 0;
    try {
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
            const p = join(dir, entry.name);
            try {
                if (entry.isDirectory())
                    latest = Math.max(latest, scanLatestMtime(p, depth + 1));
                else if (entry.name.endsWith('.zstd') || entry.name.endsWith('.jsonl'))
                    latest = Math.max(latest, statSync(p).mtimeMs);
            }
            catch { /* 单文件 stat 失败跳过 */ }
        }
    }
    catch { /* 目录不存在/无权限 */ }
    return latest;
}

/** 读配置：订阅文件优先，其次环境变量 */
export function loadEventConfig(env = process.env, home = homedir()) {
    const out = {
        url: env.HD_EVENT_URL || '',
        secret: env.HD_EVENT_SECRET || '',
    };
    if (out.url && out.secret)
        return out;
    try {
        const p = join(env.HERMES_HOME || join(home, '.hermes'), 'webhook_subscriptions.json');
        const sub = findSubscription(JSON.parse(readFileSync(p, 'utf8')));
        if (sub) {
            out.url = out.url || sub.url || sub.webhook_url || '';
            out.secret = out.secret || sub.secret || '';
        }
    }
    catch { /* 没有订阅文件就走 relay / 日志 */ }
    return out;
}

export function apply(ctx) {
    if (globalThis.__hdEventsApplied) {
        console.error('[hd-events] 已有实例（幂等保护），跳过');
        return;
    }
    // 跨进程单实例：pid 文件；旧 pid 已死就接管
    try {
        if (existsSync(LOCK)) {
            const pid = Number(readFileSync(LOCK, 'utf8'));
            if (pid > 0) {
                try {
                    process.kill(pid, 0);
                    console.error('[hd-events] 另一个进程在监控（pid ' + pid + '），跳过');
                    return;
                }
                catch { /* 旧实例已死，接管 */ }
            }
        }
        writeFileSync(LOCK, String(process.pid));
        globalThis.__hdEventsApplied = true;
    }
    catch { /* 锁失败不阻塞（保守：继续跑） */ }

    const ev = loadEventConfig();
    // relay 兜底：hd-events 复用 hermes-bridge 的连接（同一份 ~/.dsh/hermes-bridge.json）
    let link = null;
    const relayNotify = (text) => {
        try {
            if (!link) {
                // 没有 relay 配置时 getLink 会抛错，由下面的 catch 兜底（不影响 webhook 通道）
                link = getLink();
                link.start();
            }
            return link.send(link.cfg.peer, { kind: 'notify', message: text });
        }
        catch {
            return Promise.resolve(false);
        }
    };

    const post = (url, body, sig, event) => fetch(url, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'X-Hub-Signature-256': sig,
            'X-GitHub-Event': event,
        },
        body,
    });

    const notify = (event, detail) => {
        const text = '🟡 ' + event + '：' + detail;
        console.error('[hd-events] ' + event + ': ' + detail);
        if (ev.url && ev.secret) {
            const body = JSON.stringify({ event, detail, ts: Date.now() });
            const sig = 'sha256=' + createHmac('sha256', ev.secret).update(body).digest('hex');
            // 两轮重试：网络抖动 / Hermes 重启窗口
            const attempt = (n) => post(ev.url, body, sig, event)
                .then((r) => { if (!r.ok && n > 0)
                return attempt(n - 1); })
                .catch(() => (n > 0 ? attempt(n - 1) : undefined));
            attempt(2).catch(() => { });
            return;
        }
        relayNotify(text).catch(() => { });
    };

    let lastActive = 0;
    let stalledNotified = false;
    let resumedNotified = false;

    // 基线：只有最近 STALL_MIN 内写过会话才认为「正在干活」
    const latest = scanLatestMtime(SESSIONS_ROOT);
    if (latest > 0 && Date.now() - latest < STALL_MIN * 60000)
        lastActive = latest;

    const markActive = () => {
        if (stalledNotified && !resumedNotified) {
            resumedNotified = true;
            notify('hd_resumed', 'HD 会话恢复活跃（监控继续）');
        }
        lastActive = Date.now();
        stalledNotified = false;
        resumedNotified = false;
    };

    let watcher = null;
    try {
        // 主通道：递归 watch
        try {
            watcher = watch(SESSIONS_ROOT, { recursive: true }, () => markActive());
            watcher.on('error', (e) => {
                console.error('[hd-events] watch 错误（降级为扫描模式）: ' + String(e).slice(0, 200));
            });
        }
        catch (e) {
            console.error('[hd-events] recursive watch 不可用（降级为扫描模式）: ' + String(e).slice(0, 200));
        }

        // 兜底：30 秒扫一次 mtime（覆盖 watch 漏事件 / 平台不支持递归）
        const scanTimer = setInterval(() => {
            const l = scanLatestMtime(SESSIONS_ROOT);
            if (l > lastActive)
                markActive();
        }, 30000);

        // 停滞检测：只对「曾活跃」的会话计时
        const stallTimer = STALL_MIN > 0 ? setInterval(() => {
            if (lastActive > 0 && !stalledNotified) {
                const mins = Math.round((Date.now() - lastActive) / 60000);
                if (mins > STALL_MIN) {
                    stalledNotified = true;
                    resumedNotified = false;
                    notify('hd_stall', 'HD 会话 ' + mins + ' 分钟无更新（阈值 ' + STALL_MIN + ' 分钟）');
                }
            }
        }, 60000) : null;

        // 心跳（可选）：证明监控本身活着，而不是「没消息 = 没事」
        const beatTimer = HEARTBEAT_MIN > 0
            ? setInterval(() => notify('hd_alive', '监控运行中，lastActive 距今 ' + Math.round((Date.now() - (lastActive || Date.now())) / 60000) + ' 分钟'), HEARTBEAT_MIN * 60000)
            : null;

        console.error('[hd-events] 已启动：watch ' + SESSIONS_ROOT + '，停滞阈值 ' + STALL_MIN + ' 分钟，出口 ' + (ev.url && ev.secret ? 'webhook' : 'relay/日志') + '（pid ' + process.pid + '）');

        const cleanup = () => {
            try {
                unlinkSync(LOCK);
                globalThis.__hdEventsApplied = false;
            }
            catch { /* ignore */ }
            if (stallTimer)
                clearInterval(stallTimer);
            if (beatTimer)
                clearInterval(beatTimer);
            clearInterval(scanTimer);
            try {
                watcher?.close?.();
            }
            catch { /* ignore */ }
        };
        process.on('SIGTERM', () => { cleanup(); process.exit(0); });
        process.on('SIGINT', () => { cleanup(); process.exit(0); });
        ctx?.on?.('dispose', cleanup);
    }
    catch (e) {
        console.error('[hd-events] 启动失败: ' + String(e).slice(0, 200));
    }
}

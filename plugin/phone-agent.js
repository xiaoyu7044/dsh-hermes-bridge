// @ts-nocheck — 独立插件，运行时由 tsx 解析
/**
 * phone-agent — 让远端（本机 Hermes）把任务交给这台 DSH 跑，并把结果回投 + 推微信。
 *
 * 方向 B：Hermes → 手机 DSH。
 *   收 {"kind":"exec","id":"<uuid>","task":"..."}
 *   跑 `dsh headless "<task>"`（一次性、无交互、取 stdout）
 *   回 {"kind":"exec_result","id":...,"ok":true,"text":"..."} 给发起方
 *   同时（可选）POST Hermes webhook（订阅名 from-phone）→ IM 推送（企业微信/飞书/Slack 皆可），零 LLM 成本
 *
 * 为什么用 headless：DSH 没有对外的任务 API，Web UI 只有带 token 的页面；`dsh headless` 是官方
 * 的一次性入口，输出就是最终答复，适合机器调用。
 *
 * 配置（~/.dsh/hermes-bridge.json 或环境变量）：
 *   relay_url / token / client_id（=phone） / peer（=server-exec）  —— relay 通用
 *   dsh_bin        默认 dsh
 *   webhook_url    Hermes webhook 地址（形如 https://<your-host>/webhooks/<name>）
 *   webhook_secret 对应订阅的 HMAC secret（没有就不推）
 */
import { getLink } from './relay.js';
import { execFile, spawnSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';

export const name = 'phone-agent';

function cfgFile() {
    const path = process.env.HERMES_BRIDGE_CONFIG || homedir() + '/.dsh/hermes-bridge.json';
    try {
        return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : {};
    }
    catch {
        return {};
    }
}

const BRIDGE_HEADERS = process.env.DSH_BRIDGE_HEADERS || '/root/.dsh/.bridge_headers';

/** 调 Android 侧 3090 桥（token 由宿主写进 .bridge_headers，用 curl -H @file 传）。尽力而为，失败只记日志。 */
function bridgeCall(route, params) {
    try {
        const args = ['-sS', '-m', '6', '-H', '@' + BRIDGE_HEADERS, '-G', 'http://127.0.0.1:3090' + route];
        for (const [k, v] of Object.entries(params))
            args.push('--data-urlencode', k + '=' + String(v));
        const r = spawnSync('curl', args, { encoding: 'utf8', timeout: 9000 });
        return String(r.stdout || '').trim();
    }
    catch (e) {
        return 'ERR:' + String(e && e.message || e);
    }
}

/** 手机弹一条 toast，让用户看得见「Hermes 发了什么/回了什么」。 */
function popup(text) {
    const t = String(text || '').replace(/\s+/g, ' ').trim().slice(0, 120);
    if (!t)
        return;
    let body = bridgeCall('/app/toast', { text: t });
    if (/INVALID|MISSING|required|unknown/i.test(body))
        body = bridgeCall('/app/toast', { message: t });
    if (body && !/"ok"\s*:\s*true/.test(body))
        console.error('[phone-agent] toast 未确认：' + body.slice(0, 160));
}

function pushIM(link, text, meta) {
    // 微信推送走 relay 回投 server：本机 relay_client 按 peer_routes 把它投到 from-phone 订阅，
    // 这样手机端不需要任何公网入口，也不用把 webhook secret 落到手机上。
    link.send('server', { kind: 'notify', message: text, ...meta }).catch((e) => {
        console.error('[phone-agent] 推送失败：' + String(e && e.message || e));
    });
}

function runDsh(task, timeoutMs) {
    const f = cfgFile();
    const bin = process.env.DSH_BIN || f.dsh_bin || 'dsh';
    return new Promise((resolve) => {
        const t0 = Date.now();
        // `--json` 输出 NDJSON 运行事件：取 type=final 的那条就是最终答复。
        // 为什么不用裸 stdout：插件启动日志（`[hermes-bridge] 已启动…`）也走 stdout，
        // 直接取会把这些噪音当成答复返回给调用方。
        // 凭据：DSHA 的 App 把 key 写在 web profile，headless profile 读不到（MISSING_CREDENTIAL）。
        // 所以在配置里显式给一份：deepseek_api_key，或 dsh_env 任意键值，注入子进程环境。
        const extraEnv = {};
        const cfg = cfgFile();
        const key = process.env.DEEPSEEK_API_KEY || cfg.deepseek_api_key || '';
        if (key)
            extraEnv.DEEPSEEK_API_KEY = key;
        if (cfg.dsh_env && typeof cfg.dsh_env === 'object') {
            for (const [k, v] of Object.entries(cfg.dsh_env)) {
                if (typeof v === 'string' && k)
                    extraEnv[k] = v;
            }
        }
        execFile(bin, ['headless', '--json', String(task)],
            { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024, env: { ...process.env, ...extraEnv } },
            (err, stdout, stderr) => {
                const raw = String(stdout || '');
                let final = '';
                const texts = [];
                for (const line of raw.split('\n')) {
                    const t = line.trim();
                    if (!t || t[0] !== '{')
                        continue;
                    try {
                        const ev = JSON.parse(t);
                        if (ev.type === 'final' && typeof ev.text === 'string')
                            final = ev.text;
                        else if (ev.type === 'text' && typeof ev.text === 'string')
                            texts.push(ev.text);
                    }
                    catch { /* 非 JSON 行（插件日志）直接跳过 */ }
                }
                const out = (final || texts.join('')).trim();
                const ok = !err && Boolean(out);
                resolve({ ok, text: ok ? out : ('dsh 执行失败：' + String(err && err.message || err).slice(0, 500)
                    + (out ? '\n' + out : '') + (stderr ? '\n' + String(stderr).slice(-500) : '')),
                    ms: Date.now() - t0 });
            });
    });
}

export function apply(ctx) {
    if (globalThis.__phoneAgentApplied) {
        console.error('[phone-agent] 已有实例（幂等保护），跳过');
        return;
    }
    ;
    globalThis.__phoneAgentApplied = true;
    let link;
    try {
        link = getLink();
    }
    catch (e) {
        console.error('[phone-agent] 未启用：' + String(e && e.message || e));
        return;
    }
    link.start();
    let queue = Promise.resolve();
    link.onMessage((msg) => {
        const p = (msg && msg.payload) || {};
        if (p.kind !== 'exec')
            return;
        const id = String(p.id || '');
        const from = (msg && msg.from) || link.cfg.peer;
        const task = String(p.task || '').trim();
        if (!task) {
            link.send(from, { kind: 'exec_result', id, ok: false, text: '空任务' }).catch(() => { });
            return;
        }
        const timeoutMs = (Number(p.timeout_s) || 900) * 1000;
        console.error('[phone-agent] 收到任务 id=' + id + ' 长度=' + task.length);
        popup('📥 Hermes 任务：' + task);
        pushIM(link, '📥 手机已收到任务（' + task.length + ' 字），开始执行…' + task.slice(0, 60), { ok: true, ack: true });
        queue = queue.then(async () => {
            const r = await runDsh(task, timeoutMs);
            try {
                await link.send(from, { kind: 'exec_result', id, ok: r.ok, text: r.text, elapsed_ms: r.ms, mine: 'phone' });
                console.error('[phone-agent] 回投 id=' + id + ' ok=' + r.ok + ' ' + Math.round(r.ms / 1000) + 's');
            }
            catch (e) {
                console.error('[phone-agent] 回投失败：' + String(e && e.message || e));
            }
            popup((r.ok ? '✅ ' : '❌ ') + r.text);
            pushIM(link, r.text.slice(0, 3500), { task: task.slice(0, 200), ok: r.ok });
        }).catch((e) => console.error('[phone-agent] 队列异常：' + String(e && e.message || e)));
    });
    console.error('[phone-agent] 已启动：等待 exec 任务（client=' + link.cfg.client + '）');
}

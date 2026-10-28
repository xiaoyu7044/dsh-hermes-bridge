// @ts-nocheck — 独立插件，运行时由 tsx 解析
/**
 * relay.js — 手机/远端 DSH 与本机 Hermes 之间的网络中继客户端（零依赖，node:https）。
 *
 * 为什么需要它：`hermes-bridge` 原本 execFile 调本机 `hermes` 可执行文件，手机上根本没有这个
 * 二进制。改成 relay 传输后，任务打包成消息经云中转（默认 hermes.example.com:8843）发给对端执行器，
 * 结果按 id 回投，调用方拿到的仍是普通字符串——工具签名和用法都不变。
 *
 * 协议（JSON payload，双方约定）：
 *   请求  {"kind":"call_hermes","id":"<uuid>","task":"...","session":"可选","timeout_s":600}
 *   应答  {"kind":"result","id":"<同 id>","ok":true,"text":"...","elapsed_ms":12345}
 *   任务  {"kind":"exec","id":"<uuid>","task":"..."}        // 反向：Hermes 让手机 DSH 干活
 *   回执  {"kind":"exec_result","id":"<同 id>","ok":true,"text":"..."}
 *   心跳  {"kind":"ping"} / {"kind":"pong"}
 *
 * 配置（环境变量优先，其次 JSON 文件）：
 *   HERMES_RELAY_URL     例 https://hermes.example.com:8843
 *   HERMES_RELAY_TOKEN   本端 client 的 token（服务端 /etc/hermes-relay/config.json 里那条）
 *   HERMES_RELAY_CLIENT  本端 client id，默认 phone
 *   HERMES_RELAY_PEER    对端 client id，默认 server-exec
 *   HERMES_BRIDGE_CONFIG 配置文件路径，默认 ~/.dsh/hermes-bridge.json
 *
 * 注意：token 只从环境变量/本地文件读，**不进仓库、不进备份**（DSHA 备份里 .credentials 也被剔除）。
 */
import { readFileSync, appendFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { request as httpsRequest } from 'node:https';
import { randomUUID } from 'node:crypto';

const LOG_FILE = (process.env.HERMES_HOME || homedir() + '/.hermes') + '/logs/call-hermes.log';

export function relayLog(entry) {
    try {
        appendFileSync(LOG_FILE, JSON.stringify({ ts: new Date().toISOString(), via: 'relay', ...entry }) + '\n');
    }
    catch { /* 日志失败不阻塞 */ }
}

export function loadRelayConfig() {
    let file = {};
    const path = process.env.HERMES_BRIDGE_CONFIG || homedir() + '/.dsh/hermes-bridge.json';
    try {
        if (existsSync(path))
            file = JSON.parse(readFileSync(path, 'utf8'));
    }
    catch { /* 配置坏了就只靠环境变量 */ }
    const cfg = {
        url: process.env.HERMES_RELAY_URL || file.relay_url || '',
        token: process.env.HERMES_RELAY_TOKEN || file.token || '',
        client: process.env.HERMES_RELAY_CLIENT || file.client_id || 'phone',
        peer: process.env.HERMES_RELAY_PEER || file.peer || 'server-exec',
        configPath: path,
    };
    cfg.ready = Boolean(cfg.url && cfg.token);
    return cfg;
}

class RelayLink {
    constructor(cfg) {
        this.cfg = cfg;
        this.listeners = new Set();
        this.pending = new Map();
        this.started = false;
        this.connected = false;
        this.backoff = 2000;
        this.buf = '';
    }

    start() {
        if (this.started)
            return this;
        this.started = true;
        this._connect();
        return this;
    }

    onMessage(fn) {
        this.listeners.add(fn);
        return () => this.listeners.delete(fn);
    }

    _emit(msg) {
        for (const fn of this.listeners) {
            try {
                fn(msg);
            }
            catch (e) {
                console.error('[relay] listener error: ' + String(e && e.message || e));
            }
        }
    }

    _connect() {
        const base = new URL('/events', this.cfg.url);
        base.searchParams.set('client', this.cfg.client);
        base.searchParams.set('token', this.cfg.token);
        const req = httpsRequest({
            hostname: base.hostname,
            port: base.port || 443,
            path: base.pathname + base.search,
            method: 'GET',
            headers: { Accept: 'text/event-stream', 'Cache-Control': 'no-cache' },
            timeout: 0,
        }, (res) => {
            if (res.statusCode !== 200) {
                console.error('[relay] 订阅被拒 HTTP ' + res.statusCode + '（token/client 不对？）');
                res.resume();
                this.connected = false;
                this._retry();
                return;
            }
            this.connected = true;
            this.backoff = 2000;
            console.error('[relay] 已连上中转（client=' + this.cfg.client + ' peer=' + this.cfg.peer + '）');
            res.setEncoding('utf8');
            res.on('data', (chunk) => this._onChunk(chunk));
            res.on('end', () => { this.connected = false; this._retry(); });
            res.on('error', () => { this.connected = false; this._retry(); });
        });
        req.on('error', (e) => {
            console.error('[relay] 连接失败：' + String(e && e.message || e));
            this.connected = false;
            this._retry();
        });
        req.end();
    }

    _retry() {
        const wait = this.backoff;
        this.backoff = Math.min(this.backoff * 2, 30000);
        console.error('[relay] ' + (wait / 1000) + 's 后重连');
        setTimeout(() => this._connect(), wait);
    }

    _onChunk(chunk) {
        this.buf += chunk;
        let idx;
        while ((idx = this.buf.indexOf('\n')) >= 0) {
            const line = this.buf.slice(0, idx).trim();
            this.buf = this.buf.slice(idx + 1);
            if (!line || line.startsWith(':'))
                continue;
            const raw = line.startsWith('data:') ? line.slice(5).trim() : line;
            let msg;
            try {
                msg = JSON.parse(raw);
            }
            catch {
                continue;
            }
            this._dispatch(msg);
        }
    }

    _dispatch(msg) {
        const payload = (msg && msg.payload) || {};
        if (payload.kind === 'result' && payload.id && this.pending.has(payload.id)) {
            const p = this.pending.get(payload.id);
            this.pending.delete(payload.id);
            clearTimeout(p.timer);
            p.resolve(payload);
            return;
        }
        if (payload.kind === 'pong')
            return;
        this._emit(msg);
    }

    send(to, payload) {
        return new Promise((resolve, reject) => {
            const base = new URL('/send', this.cfg.url);
            base.searchParams.set('client', this.cfg.client);
            base.searchParams.set('token', this.cfg.token);
            const body = Buffer.from(JSON.stringify({ to, payload }), 'utf8');
            const req = httpsRequest({
                hostname: base.hostname,
                port: base.port || 443,
                path: base.pathname + base.search,
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Content-Length': body.length },
                timeout: 20000,
            }, (res) => {
                res.resume();
                if (res.statusCode === 200)
                    resolve(true);
                else
                    reject(new Error('relay /send HTTP ' + res.statusCode));
            });
            req.on('timeout', () => req.destroy(new Error('relay /send 超时')));
            req.on('error', reject);
            req.end(body);
        });
    }

    /** 发任务给对端执行器并等结果（同一 id 回投）。返回 {ok, text, elapsed_ms} */
    async call(task, opts = {}) {
        // opts.timeout_s 的单位是「秒」；环境变量 HERMES_TIMEOUT 沿用毫秒（见 hermes-bridge.js）。
        const secs = Number(opts.timeout_s);
        const timeoutMs = (Number.isFinite(secs) && secs > 0)
            ? Math.round(secs * 1000)
            : (Number(process.env.HERMES_TIMEOUT) || 600000);
        const id = randomUUID();
        const payload = { kind: 'call_hermes', id, task: String(task), timeout_s: Math.max(1, Math.round(timeoutMs / 1000)) };
        if (opts.session)
            payload.session = String(opts.session);
        const wait = new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pending.delete(id);
                reject(new Error('等待对端结果超时（' + Math.round(timeoutMs / 1000) + 's）'));
            }, timeoutMs + 30000);
            this.pending.set(id, { resolve, reject, timer });
        });
        this.start();
        await this.send(this.cfg.peer, payload);
        return wait;
    }
}

let _link = null;
export function getLink() {
    if (_link)
        return _link;
    const cfg = loadRelayConfig();
    if (!cfg.ready) {
        throw new Error('relay 未配置：需要 HERMES_RELAY_URL + HERMES_RELAY_TOKEN（或 ' + cfg.configPath + '）');
    }
    _link = new RelayLink(cfg);
    return _link;
}

/** 传输选择：显式 HERMES_TRANSPORT 优先；否则本机有 hermes 就 local，没有但配了 relay 就 relay */
export function pickTransport() {
    const explicit = String(process.env.HERMES_TRANSPORT || '').toLowerCase();
    if (explicit === 'relay' || explicit === 'local')
        return explicit;
    if (existsSync(process.env.HERMES_BIN || homedir() + '/.local/bin/hermes'))
        return 'local';
    return loadRelayConfig().ready ? 'relay' : 'local';
}

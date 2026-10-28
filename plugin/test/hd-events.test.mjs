import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findSubscription, loadEventConfig, scanLatestMtime } from '../hd-events.js';

test('findSubscription: dict 形状（Hermes 实际写的）', () => {
    const sub = findSubscription({
        'hd-events': { url: 'http://127.0.0.1:8644/webhooks/<name>', secret: '<secret>' },
        other: { url: 'x' },
    });
    assert.equal(sub.url, 'http://127.0.0.1:8644/webhooks/<name>');
    assert.equal(sub.secret, '<secret>');
    assert.equal(sub.name, 'hd-events');
});

test('findSubscription: {subscriptions:[...]} 形状', () => {
    const sub = findSubscription({ subscriptions: [{ name: 'hd-events', url: 'u', secret: 'k' }] });
    assert.equal(sub.secret, 'k');
});

test('findSubscription: 数组形状与缺失', () => {
    assert.equal(findSubscription([{ name: 'hd-events', url: 'u' }]).url, 'u');
    assert.equal(findSubscription([{ name: 'other' }]), null);
    assert.equal(findSubscription(null), null);
    assert.equal(findSubscription({}), null);
});

test('loadEventConfig: 环境变量优先于订阅文件', () => {
    const home = mkdtempSync(join(tmpdir(), 'hd-events-'));
    mkdirSync(join(home, '.hermes'), { recursive: true });
    writeFileSync(join(home, '.hermes', 'webhook_subscriptions.json'), JSON.stringify({
        'hd-events': { url: 'http://file/<hook>', secret: 'file-<secret>' },
    }));
    const fromFile = loadEventConfig({}, home);
    assert.equal(fromFile.url, 'http://file/<hook>');
    assert.equal(fromFile.secret, 'file-<secret>');

    const fromEnv = loadEventConfig({ HD_EVENT_URL: 'http://env/<hook>', HD_EVENT_SECRET: 'env-<secret>' }, home);
    assert.equal(fromEnv.url, 'http://env/<hook>');
    assert.equal(fromEnv.secret, 'env-<secret>');
});

test('loadEventConfig: 订阅只给 secret 时按默认端口拼 URL', () => {
    const home = mkdtempSync(join(tmpdir(), 'hd-events-'));
    mkdirSync(join(home, '.hermes'), { recursive: true });
    writeFileSync(join(home, '.hermes', 'webhook_subscriptions.json'), JSON.stringify({
        'hd-events': { secret: 'only-<secret>', deliver: 'log' },
    }));
    const cfg = loadEventConfig({}, home);
    assert.equal(cfg.secret, 'only-<secret>');
    assert.equal(cfg.url, 'http://127.0.0.1:8644' + '/webhooks/' + 'hd-events');
});

test('loadEventConfig: 没有订阅文件不抛错', () => {
    const home = mkdtempSync(join(tmpdir(), 'hd-events-'));
    assert.deepEqual(loadEventConfig({}, home), { url: '', secret: '' });
});

test('scanLatestMtime: 取最深文件的 mtime，目录不存在返回 0', () => {
    const root = mkdtempSync(join(tmpdir(), 'hd-sessions-'));
    const nested = join(root, 'a', 'b');
    mkdirSync(nested, { recursive: true });
    const oldFile = join(root, 'old.jsonl');
    const newFile = join(nested, 'new.zstd');
    writeFileSync(oldFile, '{}');
    writeFileSync(newFile, '{}');
    utimesSync(oldFile, new Date('2026-01-01'), new Date('2026-01-01'));
    utimesSync(newFile, new Date('2026-06-01'), new Date('2026-06-01'));
    assert.equal(scanLatestMtime(root), new Date('2026-06-01').getTime());
    assert.equal(scanLatestMtime(join(root, 'nope')), 0);
});

import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createHttpServer } from '../server/http';
import { SyncService } from '../server/service';
import { SqliteLog } from '../server/sqliteLog';
import { formatStamp } from '../src/core/hlc';
import type { Op } from '../src/core/ops';
import { HttpTransport } from '../src/sync/httpTransport';
import { MAX_BATCH } from '../src/sync/protocol';
import { syncAll, T0, World } from './helpers';

const op = (n: number, stampMs = T0): Op => ({
  kind: 'set', id: `op-${String(n).padStart(6, '0')}`, recordId: 'record-1',
  stamp: formatStamp(stampMs, n, 'aaaa'), fields: { type: 'feed', at: T0, amountMl: n }, base: {},
});
const open: Server[] = [];
afterEach(() => open.splice(0).forEach((s) => (s.closeAllConnections(), s.close())));

async function listen(server: Server) {
  open.push(server);
  await new Promise<void>((r) => server.listen(0, r));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}
const start = (log = new SqliteLog(':memory:')) =>
  listen(createHttpServer(new SyncService(log, () => T0, 3), new Map([['tok-a', 'A'], ['tok-b', 'B']])));
const client = (baseUrl: string, token = 'tok-a', timeoutMs?: number) => new HttpTransport({ baseUrl, token, timeoutMs });

describe('sync server over HTTP and SQLite', () => {
  it('accepts, deduplicates, and refuses an id used for something else', async () => {
    const t = client(await start());
    expect((await t.push([op(1), op(2)])).results.map((r) => r.status)).toEqual(['accepted', 'accepted']);
    expect((await t.push([op(1)])).results[0]!.status).toBe('duplicate');
    const forged = { ...op(1), recordId: 'record-2' } as Op;
    expect((await t.push([forged])).results[0]!.status).toBe('id_reused');
  });
  it('an op is the same op whatever order its keys are in', async () => {
    const t = client(await start());
    await t.push([op(1)]);
    const { base, fields, ...rest } = op(1) as Extract<Op, { kind: 'set' }>;
    const reordered = { base, fields: { amountMl: fields.amountMl, at: fields.at, type: fields.type }, ...rest } as Op;
    expect((await t.push([reordered])).results[0]!.status).toBe('duplicate');
  });
  it('one bad op does not sink the batch', async () => {
    const t = client(await start());
    const bad = { ...op(1), fields: { amountMl: -5 } } as Op;
    const res = await t.push([bad, op(2)]);
    expect(res.results.map((r) => r.status)).toEqual(['invalid', 'accepted']);
    expect(res.results[0]).toMatchObject({ id: op(1).id, reason: expect.stringContaining('amountMl') });
  });
  it('sends far-future stamps back but always acks one it already has', async () => {
    const t = client(await start());
    const edge = T0 + 5 * 60_000;
    expect((await t.push([op(1, edge), op(2, edge + 1)])).results.map((r) => r.status)).toEqual(['accepted', 'clock_ahead']);
  });
  it('pages through pulls in order', async () => {
    const t = client(await start());
    await t.push([1, 2, 3, 4].map((n) => op(n)));
    const one = await t.pull(0);
    expect(one).toMatchObject({ hasMore: true });
    const two = await t.pull(one.cursor);
    expect([...one.ops, ...two.ops].map((o) => o.op.id)).toEqual([1, 2, 3, 4].map((n) => op(n).id));
    expect(two.hasMore).toBe(false);
    expect((await t.pull(two.cursor)).cursor).toBe(two.cursor);
  });
  it('keeps households apart, even when they pick the same op id', async () => {
    const url = await start();
    await client(url).push([op(1)]);
    expect((await client(url, 'tok-b').pull(0)).ops).toEqual([]);
    expect((await client(url, 'tok-b').push([{ ...op(1), recordId: 'record-9' } as Op])).results[0]!.status).toBe('accepted');
    expect((await client(url).pull(0)).ops[0]!.op.recordId).toBe('record-1');
  });
  it('refuses unknown tokens', async () => {
    const url = await start();
    await expect(client(url, 'nope').pull(0)).rejects.toMatchObject({ kind: 'auth' });
    await expect(client(url, '').push([op(1)])).rejects.toMatchObject({ kind: 'auth' });
  });
  it('rejects bad cursors, bodies, sizes, methods and paths', async () => {
    const url = await start();
    const go = async (path: string, init?: RequestInit) =>
      (await fetch(url + path, { ...init, headers: { authorization: 'Bearer tok-a' } })).status;
    expect(await go('/v1/ops?after=-1')).toBe(400);
    expect(await go('/v1/ops?after=x')).toBe(400);
    expect(await go('/v1/ops', { method: 'POST', body: '{' })).toBe(400);
    expect(await go('/v1/ops', { method: 'POST', body: '{"ops":{}}' })).toBe(400);
    expect(await go('/v1/ops', { method: 'POST', body: JSON.stringify({ ops: Array(MAX_BATCH + 1).fill(op(1)) }) })).toBe(400);
    expect(await go('/v1/ops', { method: 'POST', body: 'x'.repeat(2 * 1024 * 1024 + 1) })).toBe(413);
    expect(await go('/v1/ops', { method: 'DELETE' })).toBe(405);
    expect(await go('/nope')).toBe(404);
  });
  it('keeps its log and epoch across restarts', async () => {
    const file = join(mkdtempSync(join(tmpdir(), 'care-srv-')), 's.db');
    const log = new SqliteLog(file);
    const before = await client(await start(log)).push([op(1)]);
    log.close();
    const after = await client(await start(new SqliteLog(file))).pull(0);
    expect(after.epoch).toBe(before.epoch);
    expect(after.ops).toHaveLength(1);
  });
  it('two engines converge through the real thing', async () => {
    const url = await start();
    const world = new World();
    const a = world.phone('aaaa', { transport: client(url) });
    const b = world.phone('bbbb', { transport: client(url) });
    for (let i = 0; i < 5; i++) a.engine.create({ type: 'diaper', diaper: 'wet', at: T0 + i, by: 'Ada' });
    await syncAll(a, b);
    expect(b.entries).toHaveLength(5);
    expect(b.entries).toEqual(a.entries);
  });
});

describe('npm run server', () => {
  const main = join(import.meta.dirname, '../server/main.ts');
  it('starts, and serves a token from TOKENS', async () => {
    const db = join(mkdtempSync(join(tmpdir(), 'care-main-')), 's.db');
    const child = spawn(process.execPath, ['--import', 'tsx', main], {
      env: { ...process.env, TOKENS: 'tok:home', PORT: '0', DB: db },
    });
    try {
      const port = await new Promise<string>((resolve, reject) => {
        child.stdout.on('data', (d) => /:(\d+)/.exec(String(d)) && resolve(/:(\d+)/.exec(String(d))![1]!));
        child.on('exit', reject);
      });
      const now = { ...op(1), stamp: formatStamp(Date.now(), 0, 'aaaa') } as Op;
      expect((await client(`http://127.0.0.1:${port}`, 'tok').push([now])).results[0]!.status).toBe('accepted');
    } finally {
      child.kill();
    }
  }, 20_000);
  it('refuses to start without tokens', async () => {
    const child = spawn(process.execPath, ['--import', 'tsx', main], { env: { ...process.env, TOKENS: '' } });
    expect(await new Promise((r) => child.on('exit', r))).toBe(1);
  }, 20_000);
});

describe('HTTP transport', () => {
  const respond = (status: number, body: string, headers = {}) =>
    listen(createServer((_q, r) => r.writeHead(status, headers).end(body)));
  it('a captive portal answering 200 with HTML is not a sync', async () => {
    await expect(client(await respond(200, '<html>Sign in</html>')).pull(0)).rejects.toMatchObject({ kind: 'protocol' });
  });
  it('passes Retry-After on', async () => {
    await expect(client(await respond(429, '{}', { 'retry-after': '7' })).pull(0)).rejects.toMatchObject({
      kind: 'server', retryAfterMs: 7000,
    });
  });
  it('times out, also when only the body stalls', async () => {
    const silent = await listen(createServer(() => {}));
    await expect(client(silent, 't', 50).pull(0)).rejects.toMatchObject({ kind: 'network' });
    const stalls = await listen(createServer((_q, r) => { r.writeHead(200); r.write('{'); }));
    await expect(client(stalls, 't', 50).pull(0)).rejects.toMatchObject({ kind: 'network' });
  });
  it('reports an unreachable server as network', async () => {
    await expect(client('http://127.0.0.1:1').pull(0)).rejects.toMatchObject({ kind: 'network' });
  });
});

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { formatStamp, parseStamp } from '../src/core/hlc';
import { backoffMs, SyncEngine } from '../src/sync/engine';
import { TransportError } from '../src/sync/protocol';
import { SqlOpStore } from '../src/sync/sqlStore';
import { MemoryOpStore } from '../src/sync/store';
import { clone, nodeDriver, syncAll, T0, World } from './helpers';

const feed = (amountMl = 100, at = T0) => ({ type: 'feed' as const, at, amountMl, by: 'Ada' });

async function pair() {
  const world = new World();
  const a = world.phone('aaaa');
  const b = world.phone('bbbb');
  const id = a.engine.create(feed());
  await syncAll(a, b);
  expect(b.entries).toHaveLength(1);
  return { world, a, b, id };
}

describe('offline edits', () => {
  it('are visible at once and survive process death before any sync', () => {
    const p = new World().phone('aaaa');
    p.online = false;
    p.engine.create(feed(120));
    expect(p.entries[0]!.fields.amountMl).toBe(120);
    p.restart();
    expect(p.entries[0]!.fields.amountMl).toBe(120);
    expect(p.engine.getSnapshot().pending).toBe(1);
  });

  it('reach the other phone after both come back', async () => {
    const world = new World();
    const a = world.phone('aaaa');
    const b = world.phone('bbbb');
    a.online = b.online = false;
    for (let i = 0; i < 7; i++) a.engine.create(feed(100 + i, T0 + i));
    b.engine.create(feed(50));
    await syncAll(a, b);
    expect(b.entries).toHaveLength(1);
    a.online = b.online = true;
    await syncAll(a, b);
    expect(a.entries).toHaveLength(8);
    expect(b.entries).toEqual(a.entries);
    expect(a.engine.getSnapshot().pending).toBe(0);
  });

  it('keep the device identity across restarts', () => {
    const p = new World().phone('aaaa');
    p.restart();
    expect(p.engine.device).toBe('aaaa');
  });

  it('sends nothing for an update that changes nothing', async () => {
    const { a, id } = await pair();
    a.pushes = [];
    a.engine.update(id, { amountMl: 100, note: undefined });
    await syncAll(a);
    expect(a.pushes).toEqual([]);
  });

  it('refuse an invalid edit before it is stored', () => {
    const p = new World().phone('aaaa');
    expect(() => p.engine.create(feed(9999))).toThrow();
    expect(p.store.all()).toEqual([]);
  });

  it('can be made while a sync is running and are sent by that sync', async () => {
    const p = new World().phone('aaaa');
    p.engine.create(feed(1));
    const run = p.engine.sync();
    p.engine.create(feed(2));
    await run;
    expect(p.engine.getSnapshot().pending).toBe(0);
  });
});

describe('concurrent edits', () => {
  it('to different fields both survive with no conflict', async () => {
    const { a, b, id } = await pair();
    a.online = b.online = false;
    a.engine.update(id, { amountMl: 120 });
    b.engine.update(id, { note: 'spat up' });
    a.online = b.online = true;
    await syncAll(a, b);
    expect(a.entries[0]!.fields).toMatchObject({ amountMl: 120, note: 'spat up' });
    expect(a.entries[0]!.conflicts).toEqual([]);
  });

  it('to one field keep both values, show the same one everywhere, and settle once', async () => {
    const { a, b, id } = await pair();
    a.online = b.online = false;
    a.engine.update(id, { amountMl: 120 });
    b.engine.update(id, { amountMl: 90 });
    a.online = b.online = true;
    await syncAll(a, b);
    expect(a.entries).toEqual(b.entries);
    expect(a.entries[0]!.conflicts[0]!.options.map((o) => o.value).sort()).toEqual([120, 90]);

    const loser = a.entries[0]!.conflicts[0]!.options[1]!.value as number;
    b.engine.resolve(id, 'amountMl', loser);
    await syncAll(a, b);
    expect(a.entries[0]!.conflicts).toEqual([]);
    expect(a.entries[0]!.fields.amountMl).toBe(loser);
  });

  it('that agree are not a conflict', async () => {
    const { a, b, id } = await pair();
    a.online = b.online = false;
    a.engine.update(id, { amountMl: 110 });
    b.engine.update(id, { amountMl: 110 });
    a.online = b.online = true;
    await syncAll(a, b);
    expect(a.entries[0]!.conflicts).toEqual([]);
  });

  it('saving the shown value of a conflicted field settles it', async () => {
    const { a, b, id } = await pair();
    a.online = b.online = false;
    a.engine.update(id, { amountMl: 120 });
    b.engine.update(id, { amountMl: 90 });
    a.online = b.online = true;
    await syncAll(a, b);
    a.engine.update(id, { amountMl: a.entries[0]!.fields.amountMl });
    await syncAll(a, b);
    expect(b.entries[0]!.conflicts).toEqual([]);
  });

  it('a later edit that saw the first replaces it, even from a phone with a slow clock', async () => {
    const { a, b, id } = await pair();
    b.clockError = -10 * 60_000;
    a.engine.update(id, { amountMl: 120 });
    await syncAll(a, b);
    b.engine.update(id, { amountMl: 95 });
    await syncAll(a, b);
    expect(a.entries[0]!.fields.amountMl).toBe(95);
    expect(a.entries[0]!.conflicts).toEqual([]);
  });
});

describe('delete against edit', () => {
  it('a plain delete removes the entry on both phones', async () => {
    const { a, b, id } = await pair();
    b.engine.remove(id);
    await syncAll(a, b);
    expect(a.entries).toEqual([]);
    expect(b.entries).toEqual([]);
  });

  it.each(['delete first', 'edit first'])('an edit the deleter had not seen brings it back whole (%s)', async (order) => {
    const { a, b, id } = await pair();
    a.online = b.online = false;
    a.engine.remove(id);
    b.engine.update(id, { note: 'took it all' });
    a.online = b.online = true;
    await (order === 'delete first' ? syncAll(a, b) : syncAll(b, a));
    expect(a.entries).toEqual(b.entries);
    expect(a.entries[0]!.fields).toMatchObject({ type: 'feed', amountMl: 100, note: 'took it all' });
    expect(a.entries[0]!.deleteConflict).toBe(true);

    a.engine.keep(id);
    await syncAll(a, b);
    expect(b.entries[0]!.deleteConflict).toBe(false);
    b.engine.remove(id);
    await syncAll(a, b);
    expect(a.entries).toEqual([]);
  });

  it('will not "keep" over values nobody has chosen between', async () => {
    const { a, b, id } = await pair();
    a.online = b.online = false;
    a.engine.update(id, { amountMl: 1 });
    a.engine.remove(id);
    b.engine.update(id, { amountMl: 2 });
    a.online = b.online = true;
    await syncAll(a, b);
    expect(a.entries[0]!.conflicts).toHaveLength(1);
    expect(() => a.engine.keep(id)).toThrow(/settle/);
  });

  it('editing an entry that is already gone is an error, not a resurrection', async () => {
    const { a, id } = await pair();
    a.engine.remove(id);
    expect(() => a.engine.update(id, { note: 'x' })).toThrow(/no longer/);
  });
});

describe('an unreliable network', () => {
  it('a lost push response does not duplicate anything', async () => {
    const world = new World();
    const a = world.phone('aaaa');
    const b = world.phone('bbbb');
    a.fault = () => 'lost-response';
    a.engine.create(feed());
    await a.engine.sync();
    expect(a.engine.getSnapshot()).toMatchObject({ pending: 1, status: 'offline' });
    a.fault = () => 'none';
    await syncAll(a, b);
    expect(b.entries).toHaveLength(1);
    expect(a.engine.getSnapshot().pending).toBe(0);
    expect(world.log.read('home', 0, 99)).toHaveLength(1);
  });

  it('single flight: overlapping sync calls never push one op twice', async () => {
    const p = new World().phone('aaaa');
    p.engine.create(feed());
    await Promise.all([p.engine.sync(), p.engine.sync(), p.engine.sync()]);
    expect(p.pushes).toHaveLength(1);
  });

  it('a sync asked for during a run runs again, to catch what that run was too early for', async () => {
    const { world, a, b } = await pair();
    const realPull = world.service.pull.bind(world.service);
    world.service.pull = (h, after) => {
      const page = realPull(h, after);
      world.service.pull = realPull;
      // Lands on the server just after this pull was answered; a push notification says "sync".
      world.service.push('home', [
        { kind: 'set', id: 'late-000001', recordId: 'late-record', stamp: formatStamp(T0, 0, 'bbbb'), fields: feed(33), base: {} },
      ]);
      void a.engine.sync();
      return page;
    };
    await a.engine.sync();
    expect(a.entries.map((e) => e.fields.amountMl)).toContain(33);
    expect(b.entries).toHaveLength(1);
  });

  it('an engine stopped in mid-push does not touch the store afterwards', async () => {
    const p = new World().phone('aaaa');
    p.engine.create(feed());
    const run = p.engine.sync();
    p.engine.stop();
    await run;
    expect(p.pushes).toHaveLength(1);
    expect(p.store.counts().pending).toBe(1);
  });

  it('backs off further each time, up to a cap, and resets after success', async () => {
    const p = new World().phone('aaaa');
    p.online = false;
    const delays: number[] = [];
    for (let i = 0; i < 4; i++) {
      await p.engine.sync();
      delays.push(p.timers.at(-1)!.ms);
    }
    expect(delays).toEqual([1000, 2000, 4000, 8000]);
    p.online = true;
    await p.engine.sync();
    p.online = false;
    await p.engine.sync();
    expect(p.timers.at(-1)!.ms).toBe(1000);
    expect(backoffMs(60, 1)).toBe(300_000);
    expect(backoffMs(5, 0)).toBe(0);
  });

  it('a manual sync cancels the scheduled retry', async () => {
    const p = new World().phone('aaaa');
    p.online = false;
    await p.engine.sync();
    p.online = true;
    await p.engine.sync();
    expect(p.timers).toEqual([]);
  });

  it('the scheduled retry actually syncs', async () => {
    const p = new World().phone('aaaa');
    p.online = false;
    p.engine.create(feed());
    await p.engine.sync();
    p.online = true;
    p.timers.at(-1)!.fn();
    await vi.waitFor(() => expect(p.engine.getSnapshot().pending).toBe(0));
  });

  const failing = (e: TransportError) => {
    const reject = () => Promise.reject(e);
    return new World().phone('aaaa', { transport: { push: reject, pull: reject } });
  };
  it('honours Retry-After when it is longer than the backoff', async () => {
    const p = failing(new TransportError('server', '429', 60_000));
    await p.engine.sync();
    expect(p.timers[0]!.ms).toBe(60_000);
    expect(p.engine.getSnapshot().status).toBe('error');
  });
  it('does not retry a refused token', async () => {
    const p = failing(new TransportError('auth', '401'));
    await p.engine.sync();
    expect(p.timers).toEqual([]);
    expect(p.engine.getSnapshot().status).toBe('auth');
  });
  it('does not schedule a retry after stop()', async () => {
    const p = failing(new TransportError('network', 'x'));
    const run = p.engine.sync();
    p.engine.stop();
    await run;
    expect(p.timers).toEqual([]);
  });
  it('treats a server that skips an op as an error instead of losing the op', async () => {
    const world = new World();
    const p = world.phone('aaaa', {
      transport: {
        push: async () => ({ epoch: 'epoch-1', serverTime: T0, results: [] }),
        pull: async (c) => ({ epoch: 'epoch-1', ops: [], cursor: c, hasMore: false }),
      },
    });
    p.engine.create(feed());
    await p.engine.sync();
    expect(p.engine.getSnapshot()).toMatchObject({ status: 'error', pending: 1 });
  });
  it('stops on a cursor that does not move', async () => {
    const p = new World().phone('aaaa', {
      transport: {
        push: async () => ({ epoch: 'e', serverTime: T0, results: [] }),
        pull: async () => ({ epoch: 'e', ops: [], cursor: 0, hasMore: true }),
      },
    });
    await p.engine.sync();
    expect(p.engine.getSnapshot().status).toBe('error');
  });
});

describe('rejected ops', () => {
  it('stay on the phone, do not block the queue, and can be retried', async () => {
    const world = new World();
    const p = world.phone('aaaa');
    const real = world.service.push.bind(world.service);
    let bad = true;
    world.service.push = (h, ops) => {
      const res = real(h, bad ? ops.slice(1) : ops);
      if (bad) res.results.unshift({ id: (ops[0] as { id: string }).id, status: 'invalid', reason: 'too new' });
      return res;
    };
    p.online = false;
    p.engine.create(feed(1));
    p.engine.create(feed(2));
    await p.engine.sync();
    p.online = true;
    await p.engine.sync();
    expect(p.engine.getSnapshot()).toMatchObject({ pending: 0, rejected: 1 });
    expect(p.entries).toHaveLength(2);
    expect(p.store.all().find((o) => o.state === 'rejected')!.reason).toBe('too new');
    bad = false;
    p.engine.retryRejected();
    await p.engine.sync();
    expect(p.engine.getSnapshot()).toMatchObject({ pending: 0, rejected: 0 });
  });
});

describe('a wrong phone clock', () => {
  it('set to the future is corrected, and its edit chain stays intact', async () => {
    const world = new World();
    const a = world.phone('aaaa');
    const b = world.phone('bbbb');
    a.clockError = 24 * 3600_000;
    a.online = false;
    const id = a.engine.create(feed(100));
    a.engine.update(id, { amountMl: 110 });
    a.engine.update(id, { amountMl: 120 });
    a.online = true;
    await syncAll(a, b);
    expect(b.entries).toEqual(a.entries);
    expect(b.entries[0]!.fields.amountMl).toBe(120);
    expect(b.entries[0]!.conflicts).toEqual([]);
    for (const { op } of world.log.read('home', 0, 99)) expect(parseStamp(op.stamp).ms).toBeLessThan(T0 + 60_000);
    // and it can not out-rank later edits by the phone with the right clock
    world.time += 60_000;
    expect(a.engine.now()).toBe(world.time);
  });

  it('remembers the correction across restarts and drops it when the clock is fixed', async () => {
    const world = new World();
    const a = world.phone('aaaa');
    a.clockError = 24 * 3600_000;
    a.engine.create(feed());
    await syncAll(a);
    a.restart();
    expect(a.engine.now()).toBe(world.time);
    a.clockError = 0;
    a.engine.create(feed());
    await syncAll(a);
    expect(a.engine.now()).toBe(world.time);
  });

  it('within ordinary latency is left alone', async () => {
    const world = new World();
    const a = world.phone('aaaa');
    a.clockError = -50_000;
    a.engine.create(feed());
    await syncAll(a);
    expect(a.engine.now()).toBe(world.time - 50_000);
    a.clockError = -70_000;
    a.engine.create(feed());
    await syncAll(a);
    expect(a.engine.now()).toBe(world.time);
    a.clockError = -50_000;
    a.engine.create(feed());
    await syncAll(a);
    expect(a.engine.now()).toBe(world.time - 50_000);
  });

  it('a delete made on the wrong clock still deletes what it saw', async () => {
    const world = new World();
    const a = world.phone('aaaa');
    const b = world.phone('bbbb');
    a.clockError = 24 * 3600_000;
    a.online = false;
    const id = a.engine.create(feed());
    a.engine.update(id, { note: 'oops' });
    a.engine.remove(id);
    a.online = true;
    await syncAll(a, b);
    expect(a.entries).toEqual([]);
    expect(b.entries).toEqual([]);
  });

  it('gives up with an error if the server keeps refusing, rather than looping', async () => {
    let calls = 0;
    const p = new World().phone('aaaa', {
      transport: {
        push: async (ops) => {
          calls += 1;
          return { epoch: 'e', serverTime: T0, results: ops.map((o) => ({ id: o.id, status: 'clock_ahead' as const })) };
        },
        pull: async (c) => ({ epoch: 'e', ops: [], cursor: c, hasMore: false }),
      },
    });
    p.engine.create(feed());
    await p.engine.sync();
    expect(calls).toBe(2);
    expect(p.engine.getSnapshot().status).toBe('error');
  });
});

describe('a server that lost its data', () => {
  it('is refilled by the phones, with nothing lost or doubled', async () => {
    const { world, a, b, id } = await pair();
    b.engine.create(feed(70));
    await syncAll(a, b);
    const before = clone(a.entries);
    world.replaceServer('epoch-2');
    a.engine.update(id, { note: 'after the crash' });
    await syncAll(a, b);
    expect(a.entries).toHaveLength(before.length);
    expect(b.entries).toEqual(a.entries);
    const c = world.phone('cccc');
    await syncAll(c);
    expect(c.entries).toEqual(a.entries);
  });
});

describe('an address with two different servers behind it', () => {
  it('is an error, not an endless re-upload', async () => {
    let n = 0;
    const p = new World().phone('aaaa', {
      transport: {
        push: async (ops) => ({ epoch: `e${++n}`, serverTime: T0, results: ops.map((o) => ({ id: o.id, status: 'accepted' as const })) }),
        pull: async (c) => ({ epoch: `e${++n}`, ops: [], cursor: c, hasMore: false }),
      },
    });
    p.engine.create(feed());
    await p.engine.sync();
    expect(p.engine.getSnapshot().status).toBe('error');
    expect(n).toBeLessThan(6);
  });
});

describe('without a server', () => {
  it('is a working local log', async () => {
    const e = new SyncEngine({ store: new MemoryOpStore(), transport: null, newId: new World().newId, newDeviceId: () => 'abcd', now: () => T0 });
    e.create(feed());
    await e.sync();
    expect(e.getSnapshot()).toMatchObject({ status: 'local', pending: 1 });
    expect(e.getSnapshot().entries).toHaveLength(1);
  });
});

describe('on a real SQLite file', () => {
  it('reopens with its entries, outbox and clock', async () => {
    const file = join(mkdtempSync(join(tmpdir(), 'care-log-')), 'phone.db');
    const world = new World();
    const db = nodeDriver(file);
    const first = world.phone('aaaa', { store: new SqlOpStore(db) });
    first.online = false;
    const id = first.engine.create(feed(80));
    first.engine.update(id, { amountMl: 85 });
    const last = first.store.all().at(-1)!.op.stamp;
    first.engine.stop();
    db.close();

    const again = world.phone('zzzz', { store: new SqlOpStore(nodeDriver(file)) });
    expect(again.engine.device).toBe('aaaa');
    expect(again.entries[0]!.fields.amountMl).toBe(85);
    again.engine.update(id, { amountMl: 90 });
    expect(again.store.all().at(-1)!.op.stamp > last).toBe(true);
    await syncAll(again);
    expect(again.engine.getSnapshot().pending).toBe(0);
  });

  it('refuses a database from a newer app version', () => {
    const db = nodeDriver();
    db.exec('PRAGMA user_version = 99');
    expect(() => new SqlOpStore(db)).toThrow(/newer/);
  });
});

it('formatStamp pads so text order is time order', () => {
  expect(formatStamp(T0, 35, 'aaaa') < formatStamp(T0, 36, 'aaaa')).toBe(true);
});

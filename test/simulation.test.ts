import fc from 'fast-check';
import { expect, it } from 'vitest';
import { SqlOpStore } from '../src/sync/sqlStore';
import { MemoryOpStore } from '../src/sync/store';
import { nodeDriver, syncAll, T0, World, type Fault } from './helpers';

/**
 * The claim the whole project rests on: whatever three phones do, over a network that drops
 * requests and responses, with clocks off by hours, processes killed and a server wiped, once
 * they can talk again they show the same thing and no op is lost.
 */
const step = fc.record({
  phone: fc.integer({ min: 0, max: 2 }),
  act: fc.oneof(
    { weight: 4, arbitrary: fc.constantFrom('create', 'amount', 'note', 'sync') },
    { weight: 1, arbitrary: fc.constantFrom('delete', 'resolve', 'restart', 'online', 'clock', 'wipe') },
  ),
  n: fc.integer({ min: 0, max: 400 }),
  fault: fc.constantFrom<Fault>('none', 'none', 'lost-request', 'lost-response'),
});

it('phones converge after any history', async () => {
  await fc.assert(
    fc.asyncProperty(fc.array(step, { minLength: 5, maxLength: 60 }), async (steps) => {
      const world = new World();
      const phones = ['aaaa', 'bbbb', 'cccc'].map((name, i) =>
        world.phone(name, { store: i === 0 ? new SqlOpStore(nodeDriver()) : new MemoryOpStore() }),
      );
      let epoch = 1;
      for (const { phone, act, n, fault } of steps) {
        const p = phones[phone]!;
        p.fault = () => fault;
        world.time += 1000;
        const target = p.entries.length ? p.entries[n % p.entries.length]! : null;
        if (act === 'create') p.engine.create({ type: 'feed', at: T0 + n, amountMl: n, by: 'x' });
        else if (act === 'amount' && target) p.engine.update(target.id, { amountMl: n });
        else if (act === 'note' && target) p.engine.update(target.id, { note: `n${n}` });
        else if (act === 'delete' && target) p.engine.remove(target.id);
        else if (act === 'resolve') {
          const c = p.entries.find((e) => e.conflicts.length);
          if (c) p.engine.resolve(c.id, c.conflicts[0]!.field, c.conflicts[0]!.options.at(-1)!.value);
        } else if (act === 'restart') p.restart();
        else if (act === 'online') p.online = !p.online;
        else if (act === 'clock') p.clockError = (n - 200) * 60_000;
        else if (act === 'wipe') world.replaceServer(`epoch-${++epoch}`);
        else if (act === 'sync') await p.engine.sync();
        // Sometimes let background syncs finish, sometimes leave them mid-flight.
        if (n % 3 === 0) await p.engine.sync();
      }
      for (const p of phones) {
        p.online = true;
        p.fault = () => 'none';
      }
      await syncAll(...phones);
      await syncAll(...phones);

      const [a, b, c] = phones;
      expect(b!.entries).toEqual(a!.entries);
      expect(c!.entries).toEqual(a!.entries);
      const ids = phones.map((p) => p.store.all().map((s) => s.op.id).sort());
      expect(ids[1]).toEqual(ids[0]);
      expect(ids[2]).toEqual(ids[0]);
      for (const p of phones) expect(p.engine.getSnapshot()).toMatchObject({ pending: 0, rejected: 0, status: 'idle' });
      // A phone installed today sees the same log, and so does one rebuilt from its own storage.
      const fresh = world.phone('dddd');
      await syncAll(fresh);
      expect(fresh.entries).toEqual(a!.entries);
      a!.restart();
      expect(a!.entries).toEqual(b!.entries);
    }),
    { numRuns: Number(process.env.SIM_RUNS ?? 300) },
  );
}, 120_000);

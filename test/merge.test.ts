import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { formatStamp, Hlc, parseStamp } from '../src/core/hlc';
import { FIELD_NAMES, opSchema, type Op } from '../src/core/ops';
import { applyOp, basesFor, emptyRecord, heads, viewRecord, type RecordState } from '../src/core/record';
import { T0 } from './helpers';

describe('hybrid logical clock', () => {
  it('sorts as text in time order', () => {
    const a = new Hlc('aaaa', () => T0);
    const stamps = Array.from({ length: 50 }, () => a.next());
    expect([...stamps].sort()).toEqual(stamps);
  });
  it('keeps increasing when the wall clock goes backwards', () => {
    let t = T0;
    const a = new Hlc('aaaa', () => t);
    const first = a.next();
    t -= 60_000;
    expect(a.next() > first).toBe(true);
  });
  it('is later than everything it has observed', () => {
    const b = new Hlc('bbbb', () => T0);
    const remote = formatStamp(T0 + 5000, 7, 'aaaa');
    b.observe(remote);
    expect(b.next() > remote).toBe(true);
  });
  it('moves to the next millisecond when the counter is full', () => {
    const b = new Hlc('bbbb', () => T0);
    b.observe(formatStamp(T0, 36 ** 4 - 1, 'aaaa'));
    expect(parseStamp(b.next())).toEqual({ ms: T0 + 1, counter: 0, device: 'bbbb' });
  });
  it('rejects malformed stamps', () => {
    expect(() => parseStamp('yesterday')).toThrow();
  });
});

/** Runs a random history on three replicas that see each other's ops at random points. */
const historyArb = fc.array(
  fc.record({
    who: fc.integer({ min: 0, max: 2 }),
    act: fc.constantFrom('amount', 'note', 'both', 'delete', 'learn'),
    value: fc.integer({ min: 0, max: 500 }),
  }),
  { minLength: 1, maxLength: 25 },
);

function play(history: { who: number; act: string; value: number }[]) {
  const ops: Op[] = [];
  const known: RecordState[] = [0, 1, 2].map(() => emptyRecord('record-1'));
  const clocks = [0, 1, 2].map((i) => new Hlc(`dev${i}`, () => T0));
  const learn = (i: number) => {
    for (const op of ops) {
      applyOp(known[i]!, op);
      clocks[i]!.observe(op.stamp);
    }
  };
  let n = 0;
  const emit = (i: number, make: (s: RecordState, stamp: string, id: string) => Op) => {
    const op = make(known[i]!, clocks[i]!.next(), `op-${String(++n).padStart(6, '0')}`);
    expect(opSchema.safeParse(op).success).toBe(true);
    ops.push(op);
    applyOp(known[i]!, op);
  };
  emit(0, (s, stamp, id) => ({
    kind: 'set', id, recordId: s.id, stamp, fields: { type: 'feed', at: T0, amountMl: 100, by: 'A' }, base: {},
  }));
  [1, 2].forEach(learn);
  for (const { who, act, value } of history) {
    if (act === 'learn') learn(who);
    else if (act === 'delete')
      emit(who, (s, stamp, id) => ({ kind: 'delete', id, recordId: s.id, stamp, seen: basesFor(s, FIELD_NAMES) }));
    else
      emit(who, (s, stamp, id) => {
        const fields = {
          ...(act !== 'note' && { amountMl: value }),
          ...(act !== 'amount' && { note: `n${value}` }),
        };
        const names = Object.keys(fields) as ('amountMl' | 'note')[];
        return { kind: 'set', id, recordId: s.id, stamp, fields, base: basesFor(s, names) };
      });
  }
  return ops;
}
const fold = (ops: Op[]) => {
  const s = emptyRecord('record-1');
  for (const op of ops) applyOp(s, op);
  return s;
};

describe('merge properties', () => {
  it('does not depend on the order or number of times ops arrive', () => {
    fc.assert(
      fc.property(historyArb, fc.infiniteStream(fc.nat()), (history, rnd) => {
        const ops = play(history);
        const shuffled = ops
          .flatMap((op) => (rnd.next().value % 3 === 0 ? [op, op] : [op]))
          .map((op) => ({ op, k: rnd.next().value }))
          .sort((a, b) => a.k - b.k)
          .map((x) => x.op);
        expect(viewRecord(fold(shuffled))).toEqual(viewRecord(fold(ops)));
      }),
      { numRuns: 400 },
    );
  });

  it('never drops an edit without a trace: each is a head or was seen by what replaced it', () => {
    fc.assert(
      fc.property(historyArb, (history) => {
        const ops = play(history);
        const state = fold(ops);
        for (const op of ops) {
          if (op.kind !== 'set' || op.fields.amountMl === undefined) continue;
          const isHead = heads(state, 'amountMl').some((h) => h.stamp === op.stamp);
          const replacer = ops.some((o) => o.kind === 'set' && o.base.amountMl?.includes(op.stamp));
          expect(isHead || replacer).toBe(true);
        }
      }),
      { numRuns: 300 },
    );
  });

  it('a delete removes a record only when its author had seen every live write', () => {
    fc.assert(
      fc.property(historyArb, (history) => {
        const ops = play(history);
        const state = fold(ops);
        const deletes = ops.filter((o) => o.kind === 'delete');
        const unseen = FIELD_NAMES.flatMap((f) => heads(state, f).map((h) => [f, h.stamp] as const)).filter(
          ([f, s]) => !deletes.some((d) => d.kind === 'delete' && d.seen[f]?.includes(s)),
        );
        expect(viewRecord(state) === null).toBe(unseen.length === 0);
      }),
      { numRuns: 300 },
    );
  });
});

describe('op schema', () => {
  const ok = { kind: 'set', id: 'op-000001', recordId: 'record-1', stamp: formatStamp(T0, 0, 'aaaa'), fields: { amountMl: 90 }, base: {} };
  it('accepts a valid op', () => expect(opSchema.safeParse(ok).success).toBe(true));
  it.each([
    ['no fields', { ...ok, fields: {} }],
    ['unknown field', { ...ok, fields: { weight: 1 } }],
    ['fractional ml', { ...ok, fields: { amountMl: 1.5 } }],
    ['negative ml', { ...ok, fields: { amountMl: -1 } }],
    ['bad stamp', { ...ok, stamp: 'now' }],
    ['seconds instead of ms', { ...ok, fields: { at: 1_700_000_000 } }],
    ['extra key', { ...ok, admin: true }],
    ['unknown kind', { ...ok, kind: 'drop' }],
  ])('rejects %s', (_n, op) => expect(opSchema.safeParse(op).success).toBe(false));
});

import { describe, expect, it } from 'vitest';
import { formatStamp } from '../src/core/hlc';
import type { Op } from '../src/core/ops';
import { SqlOpStore } from '../src/sync/sqlStore';
import { MemoryOpStore, type OpStore } from '../src/sync/store';
import { nodeDriver, T0 } from './helpers';

const op = (n: number): Op => ({
  kind: 'set', id: `op-00000${n}`, recordId: 'record-1', stamp: formatStamp(T0, n, 'aaaa'), fields: { amountMl: n }, base: {},
});

describe.each<[string, () => OpStore]>([
  ['memory', () => new MemoryOpStore()],
  ['sqlite', () => new SqlOpStore(nodeDriver())],
])('%s store', (_name, make) => {
  it('queues local ops in order and honours the limit', () => {
    const s = make();
    [1, 2, 3].forEach((n) => s.addLocal(op(n)));
    expect(s.pending(2)).toEqual([op(1), op(2)]);
    expect(s.counts()).toEqual({ pending: 3, rejected: 0 });
  });
  it('refuses the same id twice', () => {
    const s = make();
    s.addLocal(op(1));
    expect(() => s.addLocal(op(1))).toThrow();
  });
  it('acks, rejects and requeues', () => {
    const s = make();
    [1, 2].forEach((n) => s.addLocal(op(n)));
    s.markAcked([op(1).id]);
    s.markRejected(op(2).id, 'why');
    expect(s.counts()).toEqual({ pending: 0, rejected: 1 });
    expect(s.all()[1]).toEqual({ op: op(2), state: 'rejected', reason: 'why' });
    s.requeueRejected();
    expect(s.pending(9)).toEqual([op(2)]);
  });
  it('stores pulled ops once, with the cursor, and takes its own op coming back as an ack', () => {
    const s = make();
    s.addLocal(op(1));
    expect(s.addRemote([op(1), op(2)], 2)).toEqual([op(2)]);
    expect(s.addRemote([op(2)], 2)).toEqual([]);
    expect(s.counts().pending).toBe(0);
    expect(s.getMeta('cursor')).toBe('2');
    expect(s.all()).toHaveLength(2);
  });
  it('replaces in place, keeping queue order', () => {
    const s = make();
    [1, 2].forEach((n) => s.addLocal(op(n)));
    s.replace([{ oldId: op(1).id, op: op(7) }]);
    expect(s.pending(9)).toEqual([op(7), op(2)]);
  });
  it('epoch reset offers acked ops again but leaves rejected ones alone', () => {
    const s = make();
    [1, 2].forEach((n) => s.addLocal(op(n)));
    s.markAcked([op(1).id]);
    s.markRejected(op(2).id, 'no');
    s.setMeta('cursor', '9');
    s.resetForEpoch('e2');
    expect(s.pending(9)).toEqual([op(1)]);
    expect([s.getMeta('cursor'), s.getMeta('epoch')]).toEqual(['0', 'e2']);
  });
});

it('sqlite: a pulled page that fails half way leaves neither ops nor cursor', () => {
  const driver = nodeDriver();
  const s = new SqlOpStore({
    ...driver,
    run: (sql, params) => {
      if (String(params[0]).includes('op-000002')) throw new Error('disk full');
      return driver.run(sql, params);
    },
  });
  expect(() => s.addRemote([op(1), op(2)], 2)).toThrow('disk full');
  expect(s.all()).toEqual([]);
  expect(s.getMeta('cursor')).toBeNull();
  expect(s.addRemote([op(1)], 1)).toEqual([op(1)]);
});

import { describe, expect, it } from 'vitest';
import { localDay, possibleDuplicates, summarize } from '../src/core/entries';
import type { Fields } from '../src/core/ops';
import type { RecordView } from '../src/core/record';

let n = 0;
const entry = (fields: Fields, createdOn = 'aaaa'): RecordView => ({
  id: `r${++n}`, fields, conflicts: [], deleteConflict: false, createdOn,
});
const at = (h: number, m = 0, day = 25) => new Date(2026, 10, day, h, m).getTime();
const H = 3600_000;

describe('possible duplicates', () => {
  it('flags the same event logged on two phones close together', () => {
    const a = entry({ type: 'feed', at: at(3) });
    const b = entry({ type: 'feed', at: at(3, 10) }, 'bbbb');
    expect(possibleDuplicates([a, b])).toEqual(new Set([a.id, b.id]));
  });
  it.each([
    ['one phone', { type: 'feed', at: at(3, 5) }, 'aaaa'],
    ['another type', { type: 'diaper', at: at(3, 5) }, 'bbbb'],
    ['too far apart', { type: 'feed', at: at(3, 11) }, 'bbbb'],
  ] as const)('ignores %s', (_n, f, device) => {
    expect(possibleDuplicates([entry({ type: 'feed', at: at(3) }), entry(f, device)]).size).toBe(0);
  });
});

describe('day summary', () => {
  it('adds up today only', () => {
    expect(
      summarize(
        [
          entry({ type: 'feed', at: at(0), amountMl: 90 }),
          entry({ type: 'feed', at: at(9), amountMl: 110 }),
          entry({ type: 'feed', at: at(23, 59, 24), amountMl: 500 }),
          entry({ type: 'diaper', at: at(8) }),
        ],
        at(12),
      ),
    ).toEqual({ feeds: 2, feedMl: 200, diapers: 1, sleepMs: 0 });
  });
  it('counts overlapping naps once, whichever order they come in', () => {
    const naps = [
      entry({ type: 'sleep', at: at(9, 30), endAt: at(10) }),
      entry({ type: 'sleep', at: at(9), endAt: at(11) }),
      entry({ type: 'sleep', at: at(10, 30), endAt: at(12) }),
    ];
    expect(summarize(naps, at(15)).sleepMs).toBe(3 * H);
    expect(summarize(naps.reverse(), at(15)).sleepMs).toBe(3 * H);
  });
  it('clips a night that started yesterday and counts a running nap up to now', () => {
    expect(summarize([entry({ type: 'sleep', at: at(22, 0, 24), endAt: at(6) })], at(12)).sleepMs).toBe(6 * H);
    expect(summarize([entry({ type: 'sleep', at: at(11), endAt: null })], at(12)).sleepMs).toBe(H);
  });
  it('ignores a nap that ends before it starts', () => {
    expect(summarize([entry({ type: 'sleep', at: at(11), endAt: at(10) })], at(12)).sleepMs).toBe(0);
  });
  it('uses real day lengths across daylight saving (TZ pinned to Los Angeles)', () => {
    const len = (m: number, d: number) => {
      const [s, e] = localDay(new Date(2026, m, d, 12).getTime());
      return (e - s) / H;
    };
    expect([len(2, 8), len(10, 1), len(10, 25)]).toEqual([23, 25, 24]);
  });
});

import type { RecordView } from './record';

/** Two caregivers logging one real-life event. Suggest, never merge: both may be true. */
export const DUPLICATE_WINDOW_MS = 10 * 60_000;

export function sortTimeline(entries: RecordView[]): RecordView[] {
  return [...entries].sort((a, b) => b.fields.at! - a.fields.at! || (a.id < b.id ? -1 : 1));
}

export function possibleDuplicates(entries: RecordView[]): Set<string> {
  const out = new Set<string>();
  const sorted = sortTimeline(entries);
  for (let i = 0; i < sorted.length; i++) {
    for (let j = i + 1; j < sorted.length; j++) {
      const a = sorted[i]!;
      const b = sorted[j]!;
      if (a.fields.at! - b.fields.at! > DUPLICATE_WINDOW_MS) break;
      if (a.fields.type === b.fields.type && a.createdOn !== b.createdOn) out.add(a.id).add(b.id);
    }
  }
  return out;
}

export interface DaySummary {
  feeds: number;
  feedMl: number;
  diapers: number;
  sleepMs: number;
}

/** Local calendar day containing `now`; built from calendar parts so DST days are 23 or 25 hours. */
export function localDay(now: number): [start: number, end: number] {
  const d = new Date(now);
  return [
    new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime(),
    new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).getTime(),
  ];
}

export function summarize(entries: RecordView[], now: number): DaySummary {
  const [start, end] = localDay(now);
  const out: DaySummary = { feeds: 0, feedMl: 0, diapers: 0, sleepMs: 0 };
  const naps: [number, number][] = [];
  for (const { fields } of entries) {
    const at = fields.at!;
    if (fields.type === 'sleep') {
      const from = Math.max(at, start);
      const to = Math.min(fields.endAt ?? now, end);
      if (to > from) naps.push([from, to]);
    } else if (at >= start && at < end) {
      if (fields.type === 'feed') {
        out.feeds += 1;
        out.feedMl += fields.amountMl ?? 0;
      } else out.diapers += 1;
    }
  }
  // Both parents pressing "Start nap" must not double the baby's sleep: count the union.
  naps.sort((a, b) => a[0] - b[0]);
  let covered = -Infinity;
  for (const [from, to] of naps) {
    out.sleepMs += Math.max(0, to - Math.max(from, covered));
    covered = Math.max(covered, to);
  }
  return out;
}

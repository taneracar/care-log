import { parseStamp, type Stamp } from './hlc';
import { FIELD_NAMES, type Bases, type FieldName, type Fields, type FieldValue, type Op } from './ops';

/**
 * Everything known about one record. All three parts only ever grow, and applying an op is a
 * set union, so ops may arrive in any order, any number of times, and every device that has
 * the same set of ops has the same state.
 */
export interface RecordState {
  readonly id: string;
  writes: Map<FieldName, Map<Stamp, FieldValue>>;
  /** `field|stamp` of writes some later write had seen and replaced. */
  superseded: Set<string>;
  /** `field|stamp` of writes some delete had seen. */
  removed: Set<string>;
}

export const emptyRecord = (id: string): RecordState => ({
  id,
  writes: new Map(),
  superseded: new Set(),
  removed: new Set(),
});

const key = (field: string, stamp: Stamp) => `${field}|${stamp}`;

export function applyOp(state: RecordState, op: Op): void {
  if (op.kind === 'delete') {
    for (const f of FIELD_NAMES) for (const s of op.seen[f] ?? []) state.removed.add(key(f, s));
    return;
  }
  for (const f of FIELD_NAMES) {
    const value = op.fields[f];
    if (value === undefined) continue;
    let writes = state.writes.get(f);
    if (!writes) state.writes.set(f, (writes = new Map()));
    writes.set(op.stamp, value);
    for (const s of op.base[f] ?? []) state.superseded.add(key(f, s));
  }
}

export interface Head {
  stamp: Stamp;
  device: string;
  value: FieldValue;
  removed: boolean;
}

/** Writes of a field nobody has replaced, newest stamp first. More than one means concurrent edits. */
export function heads(state: RecordState, field: FieldName): Head[] {
  const out: Head[] = [];
  for (const [stamp, value] of state.writes.get(field) ?? []) {
    if (state.superseded.has(key(field, stamp))) continue;
    out.push({ stamp, value, device: parseStamp(stamp).device, removed: state.removed.has(key(field, stamp)) });
  }
  return out.sort((a, b) => (a.stamp < b.stamp ? 1 : -1));
}

export interface Conflict {
  field: FieldName;
  options: Head[];
}

export interface RecordView {
  id: string;
  fields: Fields;
  conflicts: Conflict[];
  /** Someone deleted this while someone else, not knowing, edited it. The edit kept it alive. */
  deleteConflict: boolean;
  createdOn: string;
}

/** null when the record is deleted, or when its first write has not arrived yet. */
export function viewRecord(state: RecordState): RecordView | null {
  const fields: Record<string, FieldValue> = {};
  const conflicts: Conflict[] = [];
  let alive = false;
  let anyRemoved = false;
  for (const f of FIELD_NAMES) {
    const hs = heads(state, f);
    if (!hs[0]) continue;
    fields[f] = hs[0].value;
    for (const h of hs) {
      if (h.removed) anyRemoved = true;
      else alive = true;
    }
    const distinct = hs.filter((h, i) => hs.findIndex((o) => o.value === h.value) === i);
    if (distinct.length > 1) conflicts.push({ field: f, options: distinct });
  }
  if (!alive || fields.type === undefined || fields.at === undefined) return null;
  const firstType = [...state.writes.get('type')!.keys()].sort()[0]!;
  return {
    id: state.id,
    fields: fields as Fields,
    conflicts,
    deleteConflict: anyRemoved,
    createdOn: parseStamp(firstType).device,
  };
}

export function basesFor(state: RecordState, fields: readonly FieldName[]): Bases {
  const out: Bases = {};
  for (const f of fields) {
    const hs = heads(state, f);
    if (hs.length) out[f] = hs.map((h) => h.stamp);
  }
  return out;
}

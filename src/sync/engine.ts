import { Hlc } from '../core/hlc';
import { FIELD_NAMES, opSchema, type Bases, type FieldName, type Fields, type Op } from '../core/ops';
import { applyOp, basesFor, emptyRecord, viewRecord, type RecordState, type RecordView } from '../core/record';
import { sortTimeline } from '../core/entries';
import { MAX_BATCH, TransportError, type PushResponse, type Transport } from './protocol';
import type { OpStore } from './store';

export type SyncStatus = 'idle' | 'syncing' | 'offline' | 'error' | 'auth' | 'local';

export interface Snapshot {
  entries: RecordView[];
  status: SyncStatus;
  pending: number;
  rejected: number;
  lastSyncedAt: number | null;
}

export interface EngineDeps {
  store: OpStore;
  /** null: no server configured, the app is a plain local log. */
  transport: Transport | null;
  newId: () => string;
  newDeviceId: () => string;
  now?: () => number;
  random?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

const BACKOFF_BASE_MS = 1_000;
const BACKOFF_MAX_MS = 5 * 60_000;
/** Below this, "wrong clock" is indistinguishable from network latency. */
const MIN_CLOCK_CORRECTION_MS = 60_000;

/** Full jitter: many phones coming back online together must not retry together. */
export function backoffMs(failures: number, random: number): number {
  return Math.round(random * Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** Math.max(0, failures - 1)));
}

export class SyncEngine {
  readonly device: string;
  private records = new Map<string, RecordState>();
  private clock!: Hlc;
  private offset: number;
  private listeners = new Set<() => void>();
  private status: SyncStatus;
  private lastSyncedAt: number | null = null;
  private running: Promise<void> | null = null;
  private rerun = false;
  private resetThisRun = false;
  private failures = 0;
  private timer: unknown = null;
  private stopped = false;
  private snap!: Snapshot;

  private readonly wall: () => number;
  private readonly random: () => number;
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly clearTimer: (h: unknown) => void;

  constructor(private readonly deps: EngineDeps) {
    this.wall = deps.now ?? Date.now;
    this.random = deps.random ?? Math.random;
    this.setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = deps.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
    let device = deps.store.getMeta('device');
    if (!device) deps.store.setMeta('device', (device = deps.newDeviceId()));
    this.device = device;
    this.offset = Number(deps.store.getMeta('clockOffset') ?? 0);
    this.status = deps.transport ? 'idle' : 'local';
    this.rebuild();
    this.publish();
  }

  /** Device time, corrected if the server told us our clock is wrong. */
  now(): number {
    return this.wall() + this.offset;
  }

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };
  getSnapshot = (): Snapshot => this.snap;

  // ---- local edits: durable first, then visible, then (eventually) sent ----

  create(fields: Fields): string {
    const recordId = this.deps.newId();
    this.commit({ kind: 'set', id: this.deps.newId(), recordId, stamp: this.clock.next(), fields, base: {} });
    return recordId;
  }

  /** Writes only what changed, so two people editing different fields never conflict. */
  update(recordId: string, patch: Fields): void {
    const state = this.record(recordId);
    const view = viewRecord(state);
    if (!view) throw new Error('entry no longer exists');
    const conflicted = new Set(view.conflicts.map((c) => c.field));
    const changed = FIELD_NAMES.filter(
      (f) => patch[f] !== undefined && (patch[f] !== view.fields[f] || conflicted.has(f)),
    );
    this.write(state, changed, patch);
  }

  /** Settle a conflict. The losing value is superseded, not erased from the log. */
  resolve(recordId: string, field: FieldName, value: Fields[FieldName]): void {
    this.write(this.record(recordId), [field], { [field]: value });
  }

  /** "Yes, keep it": rewrite every field so nothing on the record is marked deleted any more. */
  keep(recordId: string): void {
    const state = this.record(recordId);
    const view = viewRecord(state);
    if (!view) throw new Error('entry no longer exists');
    const conflicted = new Set(view.conflicts.map((c) => c.field));
    const safe = FIELD_NAMES.filter((f) => view.fields[f] !== undefined && !conflicted.has(f));
    if (conflicted.size) throw new Error('settle the conflicting values first');
    this.write(state, safe, view.fields);
  }

  remove(recordId: string): void {
    const state = this.record(recordId);
    if (!viewRecord(state)) return;
    this.commit({
      kind: 'delete',
      id: this.deps.newId(),
      recordId,
      stamp: this.clock.next(),
      seen: basesFor(state, FIELD_NAMES),
    });
  }

  retryRejected(): void {
    this.deps.store.requeueRejected();
    this.publish();
    void this.sync();
  }

  // ---- sync ----

  /** Single flight. A call during a run asks for one more run instead of a parallel one. */
  sync(): Promise<void> {
    if (!this.deps.transport || this.stopped) return Promise.resolve();
    if (this.running) {
      this.rerun = true;
      return this.running;
    }
    this.cancelTimer();
    this.running = this.loop().finally(() => {
      this.running = null;
    });
    return this.running;
  }

  stop(): void {
    this.stopped = true;
    this.cancelTimer();
  }

  private async loop(): Promise<void> {
    this.resetThisRun = false;
    this.setStatus('syncing');
    try {
      do {
        this.rerun = false;
        await this.pushAll(this.deps.transport!);
        await this.pullAll(this.deps.transport!);
      } while ((this.rerun || this.deps.store.pending(1).length > 0) && !this.stopped);
      if (this.stopped) return;
      this.failures = 0;
      this.lastSyncedAt = this.now();
      this.setStatus('idle');
    } catch (e) {
      this.fail(e);
    }
  }

  private async pushAll(transport: Transport): Promise<void> {
    let restamps = 0;
    for (;;) {
      if (this.stopped) return;
      const batch = this.deps.store.pending(MAX_BATCH);
      if (batch.length === 0) return;
      const res = await transport.push(batch);
      // Stopped while waiting: another engine may own this store now. Dropping the answer is
      // safe, the server deduplicates when these ops are pushed again.
      if (this.stopped) return;
      this.checkEpoch(res.epoch);
      const sent = new Map(batch.map((o) => [o.id, o]));
      const answered = new Set(res.results.map((r) => r.id).filter((id) => sent.has(id)));
      if (answered.size !== batch.length) throw new TransportError('protocol', 'server did not answer every op');
      this.applyResults(res);
      this.correctClock(res.serverTime);
      const ahead = new Set(res.results.filter((r) => r.status === 'clock_ahead').map((r) => r.id));
      if (ahead.size) {
        // One correction must be enough; if not, stop instead of hammering the server.
        if (++restamps > 1) throw new TransportError('protocol', 'stamps still ahead after correction');
        this.restamp();
      }
      this.publish();
    }
  }

  private applyResults(res: PushResponse): void {
    this.deps.store.markAcked(
      res.results.filter((r) => r.status === 'accepted' || r.status === 'duplicate').map((r) => r.id),
    );
    for (const r of res.results) {
      if (r.status === 'invalid' || r.status === 'id_reused') {
        this.deps.store.markRejected(r.id, r.reason ?? r.status);
      }
    }
  }

  private async pullAll(transport: Transport): Promise<void> {
    for (;;) {
      if (this.stopped) return;
      const before = Number(this.deps.store.getMeta('cursor') ?? 0);
      const res = await transport.pull(before);
      if (this.stopped) return;
      if (this.checkEpoch(res.epoch)) continue;
      if (res.hasMore && res.cursor <= before) throw new TransportError('protocol', 'cursor did not advance');
      const fresh = this.deps.store.addRemote(res.ops.map((o) => o.op), res.cursor);
      for (const op of fresh) this.applyToMemory(op);
      if (res.ops.length) this.publish();
      if (!res.hasMore) return;
    }
  }

  /** True when the server's log is not the one our cursor points into. */
  private checkEpoch(epoch: string): boolean {
    const known = this.deps.store.getMeta('epoch');
    if (known === epoch) return false;
    if (known === null) {
      this.deps.store.setMeta('epoch', epoch);
      return false;
    }
    // Two resets in one run means the epoch keeps changing (say, two servers behind one address).
    if (this.resetThisRun) throw new TransportError('protocol', 'server epoch is not stable');
    this.resetThisRun = true;
    this.deps.store.resetForEpoch(epoch);
    this.publish();
    return true;
  }

  private correctClock(serverTime: number): void {
    // Measured from the raw clock every time, so fixing the phone's clock also drops the correction.
    const error = serverTime - this.wall();
    const offset = Math.abs(error) < MIN_CLOCK_CORRECTION_MS ? 0 : error;
    if (Math.abs(offset - this.offset) < MIN_CLOCK_CORRECTION_MS) return;
    this.offset = offset;
    this.deps.store.setMeta('clockOffset', String(offset));
  }

  /**
   * Give every still-pending op a new stamp from the corrected clock. The server has none of
   * them, so nobody else can refer to the old stamps; our own later ops can, so their bases
   * are rewritten with the same mapping. New ids, because the body changed.
   */
  private restamp(): void {
    const stored = this.deps.store.all();
    const clock = new Hlc(this.device, () => this.now());
    for (const s of stored) if (s.state === 'acked') clock.observe(s.op.stamp);
    const renamed = new Map<string, string>();
    const remap = (b: Bases): Bases =>
      Object.fromEntries(Object.entries(b).map(([f, ss]) => [f, ss!.map((s) => renamed.get(s) ?? s)])) as Bases;
    const changes = stored
      .filter((s) => s.state === 'pending')
      .map(({ op }) => {
        const stamp = clock.next();
        renamed.set(op.stamp, stamp);
        const next: Op =
          op.kind === 'set'
            ? { ...op, id: this.deps.newId(), stamp, base: remap(op.base) }
            : { ...op, id: this.deps.newId(), stamp, seen: remap(op.seen) };
        return { oldId: op.id, op: next };
      });
    this.deps.store.replace(changes);
    this.rebuild();
  }

  private fail(e: unknown): void {
    if (this.stopped) return;
    const err = e instanceof TransportError ? e : new TransportError('protocol', String(e));
    if (err.kind === 'auth') {
      // Retrying a refused token is pointless; wait for the user.
      this.setStatus('auth');
      return;
    }
    this.failures += 1;
    const delay = Math.max(err.retryAfterMs ?? 0, backoffMs(this.failures, this.random()));
    this.setStatus(err.kind === 'network' ? 'offline' : 'error');
    this.timer = this.setTimer(() => void this.sync(), delay);
  }

  // ---- internals ----

  private write(state: RecordState, names: FieldName[], values: Fields): void {
    if (names.length === 0) return;
    const fields = Object.fromEntries(names.map((f) => [f, values[f]])) as Fields;
    this.commit({
      kind: 'set',
      id: this.deps.newId(),
      recordId: state.id,
      stamp: this.clock.next(),
      fields,
      base: basesFor(state, names),
    });
  }

  private commit(op: Op): void {
    opSchema.parse(op);
    this.deps.store.addLocal(op);
    this.applyToMemory(op);
    this.publish();
    void this.sync();
  }

  private record(id: string): RecordState {
    const state = this.records.get(id);
    if (!state) throw new Error(`no such entry: ${id}`);
    return state;
  }

  private applyToMemory(op: Op): void {
    let state = this.records.get(op.recordId);
    if (!state) this.records.set(op.recordId, (state = emptyRecord(op.recordId)));
    applyOp(state, op);
    this.clock.observe(op.stamp);
  }

  private rebuild(): void {
    this.records = new Map();
    this.clock = new Hlc(this.device, () => this.now());
    for (const { op } of this.deps.store.all()) this.applyToMemory(op);
  }

  private cancelTimer(): void {
    if (this.timer !== null) this.clearTimer(this.timer);
    this.timer = null;
  }

  private setStatus(s: SyncStatus): void {
    this.status = s;
    this.publish();
  }

  private publish(): void {
    const entries = [...this.records.values()].map(viewRecord).filter((v): v is RecordView => v !== null);
    this.snap = {
      entries: sortTimeline(entries),
      status: this.status,
      ...this.deps.store.counts(),
      lastSyncedAt: this.lastSyncedAt,
    };
    for (const fn of this.listeners) fn();
  }
}

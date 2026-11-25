import type { Op } from '../core/ops';

/**
 * The device's durable state. The outbox is not a separate queue: it is the ops in this log
 * that the server has not confirmed. One insert both records the edit and queues it, so a
 * crash can not leave an edit on screen that will never be sent.
 */
export type OpState = 'pending' | 'acked' | 'rejected';
export interface StoredOp {
  op: Op;
  state: OpState;
  reason: string | null;
}
export interface OpStore {
  all(): StoredOp[];
  pending(limit: number): Op[];
  addLocal(op: Op): void;
  /** Store a pulled page and its cursor together. Returns the ops that were new here. */
  addRemote(ops: Op[], cursor: number): Op[];
  markAcked(ids: string[]): void;
  markRejected(id: string, reason: string): void;
  requeueRejected(): void;
  /** Replace never-accepted ops by restamped copies, in the same queue positions. */
  replace(changes: { oldId: string; op: Op }[]): void;
  /** The server lost its log: start pulling from zero and offer everything again. */
  resetForEpoch(epoch: string): void;
  counts(): { pending: number; rejected: number };
  getMeta(key: string): string | null;
  setMeta(key: string, value: string): void;
}

export class MemoryOpStore implements OpStore {
  private rows: StoredOp[] = [];
  private meta = new Map<string, string>();

  all() {
    return this.rows.map((r) => ({ ...r }));
  }
  pending(limit: number) {
    return this.rows.filter((r) => r.state === 'pending').slice(0, limit).map((r) => r.op);
  }
  addLocal(op: Op) {
    if (this.find(op.id)) throw new Error(`op ${op.id} already stored`);
    this.rows.push({ op, state: 'pending', reason: null });
  }
  addRemote(ops: Op[], cursor: number) {
    const fresh: Op[] = [];
    for (const op of ops) {
      const row = this.find(op.id);
      if (row) Object.assign(row, { state: 'acked', reason: null });
      else {
        this.rows.push({ op, state: 'acked', reason: null });
        fresh.push(op);
      }
    }
    this.setMeta('cursor', String(cursor));
    return fresh;
  }
  markAcked(ids: string[]) {
    for (const id of ids) {
      const row = this.find(id);
      if (row) Object.assign(row, { state: 'acked', reason: null });
    }
  }
  markRejected(id: string, reason: string) {
    const row = this.find(id);
    if (row) Object.assign(row, { state: 'rejected', reason });
  }
  requeueRejected() {
    for (const r of this.rows) if (r.state === 'rejected') Object.assign(r, { state: 'pending', reason: null });
  }
  replace(changes: { oldId: string; op: Op }[]) {
    for (const { oldId, op } of changes) {
      const row = this.find(oldId);
      if (row) row.op = op;
    }
  }
  resetForEpoch(epoch: string) {
    for (const r of this.rows) if (r.state === 'acked') r.state = 'pending';
    this.setMeta('cursor', '0');
    this.setMeta('epoch', epoch);
  }
  counts() {
    return {
      pending: this.rows.filter((r) => r.state === 'pending').length,
      rejected: this.rows.filter((r) => r.state === 'rejected').length,
    };
  }
  getMeta(k: string) {
    return this.meta.get(k) ?? null;
  }
  setMeta(k: string, v: string) {
    this.meta.set(k, v);
  }
  private find(id: string) {
    return this.rows.find((r) => r.op.id === id);
  }
}

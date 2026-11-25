import type { Op } from '../src/core/ops';

export interface LoggedOp {
  seq: number;
  op: Op;
}
export interface OpLog {
  readonly epoch: string;
  get(household: string, id: string): Op | null;
  append(household: string, op: Op): void;
  /** Ops after `after`, in seq order. */
  read(household: string, after: number, limit: number): LoggedOp[];
}

export class MemoryLog implements OpLog {
  private rows: (LoggedOp & { household: string })[] = [];
  constructor(readonly epoch: string) {}
  get(household: string, id: string) {
    return this.rows.find((r) => r.household === household && r.op.id === id)?.op ?? null;
  }
  append(household: string, op: Op) {
    this.rows.push({ household, seq: this.rows.length + 1, op });
  }
  read(household: string, after: number, limit: number) {
    return this.rows
      .filter((r) => r.household === household && r.seq > after)
      .slice(0, limit)
      .map(({ seq, op }) => ({ seq, op }));
  }
}

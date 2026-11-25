import { parseStamp } from '../src/core/hlc';
import { opSchema, type Op } from '../src/core/ops';
import { MAX_AHEAD_MS, type PullResponse, type PushResponse, type PushResult } from '../src/sync/protocol';
import type { OpLog } from './log';

/**
 * The server never merges anything. It validates, orders and stores ops; the merge is the same
 * pure function on every phone, so there is no server copy to disagree with.
 */
export class SyncService {
  constructor(
    private readonly log: OpLog,
    private readonly now: () => number = Date.now,
    private readonly pageSize = 200,
  ) {}

  push(household: string, rawOps: unknown[]): PushResponse {
    return {
      epoch: this.log.epoch,
      serverTime: this.now(),
      results: rawOps.map((raw) => this.pushOne(household, raw)),
    };
  }

  pull(household: string, after: number): PullResponse {
    const rows = this.log.read(household, after, this.pageSize + 1);
    const ops = rows.slice(0, this.pageSize);
    return {
      epoch: this.log.epoch,
      ops,
      cursor: ops.at(-1)?.seq ?? after,
      hasMore: rows.length > this.pageSize,
    };
  }

  private pushOne(household: string, raw: unknown): PushResult {
    const parsed = opSchema.safeParse(raw);
    if (!parsed.success) {
      const id = (raw as { id?: unknown } | null)?.id;
      const issue = parsed.error.issues[0];
      return {
        id: typeof id === 'string' ? id : '',
        status: 'invalid',
        reason: issue ? `${issue.path.join('.')}: ${issue.message}` : 'invalid',
      };
    }
    const op = parsed.data;
    // Duplicate check before the clock check: an op we already took must always be acked.
    const existing = this.log.get(household, op.id);
    if (existing) {
      return sameOp(existing, op)
        ? { id: op.id, status: 'duplicate' }
        : { id: op.id, status: 'id_reused', reason: 'id was used for a different op' };
    }
    if (parseStamp(op.stamp).ms > this.now() + MAX_AHEAD_MS) return { id: op.id, status: 'clock_ahead' };
    this.log.append(household, op);
    return { id: op.id, status: 'accepted' };
  }
}

/** Both sides have been through the schema, so compare structurally, not by key order. */
function sameOp(a: Op, b: Op): boolean {
  return canonical(a) === canonical(b);
}
function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join()}]`;
  if (v && typeof v === 'object') {
    return `{${Object.entries(v).sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, x]) => `${JSON.stringify(k)}:${canonical(x)}`).join()}}`;
  }
  return JSON.stringify(v);
}

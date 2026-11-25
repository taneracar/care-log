import type { Op } from '../core/ops';
import type { OpStore, OpState, StoredOp } from './store';

/** The few calls we need. expo-sqlite implements it on the phone, node:sqlite in tests. */
export interface SqlDriver {
  exec(sql: string): void;
  run(sql: string, params: (string | number | null)[]): number;
  all<T>(sql: string, params: (string | number | null)[]): T[];
}

interface Row {
  body: string;
  state: OpState;
  reason: string | null;
}

/** Ordered; `user_version` records how many have run. Append only, never edit a shipped one. */
const MIGRATIONS = [
  `CREATE TABLE ops (
     n INTEGER PRIMARY KEY AUTOINCREMENT,
     id TEXT NOT NULL UNIQUE,
     body TEXT NOT NULL,
     state TEXT NOT NULL CHECK (state IN ('pending','acked','rejected')),
     reason TEXT
   );
   CREATE INDEX ops_outbox ON ops (n) WHERE state = 'pending';
   CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);`,
];

export class SqlOpStore implements OpStore {
  constructor(private readonly db: SqlDriver) {
    db.exec('PRAGMA journal_mode = WAL');
    const version = db.all<{ user_version: number }>('PRAGMA user_version', [])[0]!.user_version;
    if (version > MIGRATIONS.length) throw new Error('database was written by a newer version of the app');
    for (let v = version; v < MIGRATIONS.length; v++) {
      this.tx(() => db.exec(`${MIGRATIONS[v]} PRAGMA user_version = ${v + 1};`));
    }
  }

  all(): StoredOp[] {
    return this.db
      .all<Row>('SELECT body, state, reason FROM ops ORDER BY n', [])
      .map((r) => ({ op: JSON.parse(r.body) as Op, state: r.state, reason: r.reason }));
  }
  pending(limit: number): Op[] {
    return this.db
      .all<Row>(`SELECT body FROM ops WHERE state = 'pending' ORDER BY n LIMIT ?`, [limit])
      .map((r) => JSON.parse(r.body) as Op);
  }
  addLocal(op: Op) {
    this.db.run(`INSERT INTO ops (id, body, state) VALUES (?, ?, 'pending')`, [op.id, JSON.stringify(op)]);
  }
  addRemote(ops: Op[], cursor: number): Op[] {
    const fresh: Op[] = [];
    this.tx(() => {
      for (const op of ops) {
        const inserted = this.db.run(
          `INSERT INTO ops (id, body, state) VALUES (?, ?, 'acked') ON CONFLICT (id) DO NOTHING`,
          [op.id, JSON.stringify(op)],
        );
        if (inserted) fresh.push(op);
        else this.markAcked([op.id]);
      }
      this.setMeta('cursor', String(cursor));
    });
    return fresh;
  }
  markAcked(ids: string[]) {
    for (const id of ids) this.db.run(`UPDATE ops SET state = 'acked', reason = NULL WHERE id = ?`, [id]);
  }
  markRejected(id: string, reason: string) {
    this.db.run(`UPDATE ops SET state = 'rejected', reason = ? WHERE id = ?`, [reason, id]);
  }
  requeueRejected() {
    this.db.run(`UPDATE ops SET state = 'pending', reason = NULL WHERE state = 'rejected'`, []);
  }
  replace(changes: { oldId: string; op: Op }[]) {
    this.tx(() => {
      for (const { oldId, op } of changes) {
        this.db.run('UPDATE ops SET id = ?, body = ? WHERE id = ?', [op.id, JSON.stringify(op), oldId]);
      }
    });
  }
  resetForEpoch(epoch: string) {
    this.tx(() => {
      this.db.run(`UPDATE ops SET state = 'pending' WHERE state = 'acked'`, []);
      this.setMeta('cursor', '0');
      this.setMeta('epoch', epoch);
    });
  }
  counts() {
    const n = (s: OpState) =>
      this.db.all<{ c: number }>('SELECT COUNT(*) AS c FROM ops WHERE state = ?', [s])[0]!.c;
    return { pending: n('pending'), rejected: n('rejected') };
  }
  getMeta(k: string) {
    return this.db.all<{ value: string }>('SELECT value FROM meta WHERE key = ?', [k])[0]?.value ?? null;
  }
  setMeta(k: string, v: string) {
    this.db.run('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value', [
      k,
      v,
    ]);
  }

  private tx(work: () => void) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      work();
      this.db.exec('COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }
}

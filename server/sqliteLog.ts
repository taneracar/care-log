import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import type { Op } from '../src/core/ops';
import type { OpLog } from './log';

export class SqliteLog implements OpLog {
  readonly epoch: string;
  private readonly db: DatabaseSync;

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS ops (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        household TEXT NOT NULL,
        id TEXT NOT NULL,
        body TEXT NOT NULL,
        UNIQUE (household, id)
      );
      CREATE INDEX IF NOT EXISTS ops_feed ON ops (household, seq);
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);`);
    this.db.prepare(`INSERT INTO meta VALUES ('epoch', ?) ON CONFLICT DO NOTHING`).run(randomUUID());
    this.epoch = (this.db.prepare(`SELECT value FROM meta WHERE key = 'epoch'`).get() as { value: string }).value;
  }
  get(household: string, id: string) {
    const row = this.db.prepare('SELECT body FROM ops WHERE household = ? AND id = ?').get(household, id);
    return row ? (JSON.parse((row as { body: string }).body) as Op) : null;
  }
  append(household: string, op: Op) {
    this.db.prepare('INSERT INTO ops (household, id, body) VALUES (?, ?, ?)').run(household, op.id, JSON.stringify(op));
  }
  read(household: string, after: number, limit: number) {
    const rows = this.db
      .prepare('SELECT seq, body FROM ops WHERE household = ? AND seq > ? ORDER BY seq LIMIT ?')
      .all(household, after, limit) as { seq: number; body: string }[];
    return rows.map((r) => ({ seq: r.seq, op: JSON.parse(r.body) as Op }));
  }
  close() {
    this.db.close();
  }
}

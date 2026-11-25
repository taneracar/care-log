import { DatabaseSync } from 'node:sqlite';
import { MemoryLog, type OpLog } from '../server/log';
import { SyncService } from '../server/service';
import type { Op } from '../src/core/ops';
import { SyncEngine, type EngineDeps } from '../src/sync/engine';
import { TransportError, type Transport } from '../src/sync/protocol';
import type { SqlDriver } from '../src/sync/sqlStore';
import { MemoryOpStore, type OpStore } from '../src/sync/store';

export const T0 = Date.UTC(2026, 10, 25, 18, 0, 0);

export function nodeDriver(path = ':memory:'): SqlDriver & { close(): void } {
  const db = new DatabaseSync(path);
  return {
    exec: (sql) => db.exec(sql),
    run: (sql, params) => Number(db.prepare(sql).run(...params).changes),
    all: <T>(sql: string, params: (string | number | null)[]) => db.prepare(sql).all(...params) as T[],
    close: () => db.close(),
  };
}

export class World {
  time = T0;
  private ids = 0;
  log: OpLog = new MemoryLog('epoch-1');
  service = new SyncService(this.log, () => this.time, 3);

  newId = () => `id-${String(++this.ids).padStart(8, '0')}`;
  replaceServer(epoch: string) {
    this.log = new MemoryLog(epoch);
    this.service = new SyncService(this.log, () => this.time, 3);
  }
  phone(name: string, over: Partial<EngineDeps> = {}) {
    return new Phone(this, name, over);
  }
}

export type Fault = 'none' | 'lost-request' | 'lost-response';

/** A phone whose network can lose either half of any call, and which can be killed and reopened. */
export class Phone {
  online = true;
  clockError = 0;
  /** Asked once per call. */
  fault: () => Fault = () => 'none';
  timers: { fn: () => void; ms: number }[] = [];
  pushes: Op[][] = [];
  engine: SyncEngine;
  readonly store: OpStore;

  constructor(
    private readonly world: World,
    private readonly name: string,
    private readonly over: Partial<EngineDeps>,
  ) {
    this.store = over.store ?? new MemoryOpStore();
    this.engine = this.boot();
  }
  /** Process death: memory is gone, the store survives. */
  restart() {
    this.engine.stop();
    this.engine = this.boot();
  }
  private boot() {
    return new SyncEngine({
      store: this.store,
      transport: this.transport,
      newId: this.world.newId,
      newDeviceId: () => this.name,
      now: () => this.world.time + this.clockError,
      random: () => 1,
      setTimer: (fn, ms) => this.timers.push({ fn, ms }),
      clearTimer: () => {
        this.timers = [];
      },
      ...this.over,
    });
  }
  private transport: Transport = {
    push: (ops) => this.call(() => this.world.service.push('home', (this.pushes.push(ops), clone(ops)))),
    pull: (after) => this.call(() => this.world.service.pull('home', after)),
  };
  private async call<T>(request: () => T): Promise<T> {
    await Promise.resolve();
    const fault = this.fault();
    if (!this.online || fault === 'lost-request') throw new TransportError('network', 'offline');
    const response = clone(request());
    await Promise.resolve();
    if (fault === 'lost-response') throw new TransportError('network', 'connection reset');
    return response;
  }
  get entries() {
    return this.engine.getSnapshot().entries;
  }
}
export const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

export async function syncAll(...phones: Phone[]) {
  for (let i = 0; i < 3; i++) for (const p of phones) await p.engine.sync();
}

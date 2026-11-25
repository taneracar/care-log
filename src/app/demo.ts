import { MemoryLog } from '../../server/log';
import { SyncService } from '../../server/service';
import { SyncEngine } from '../sync/engine';
import { TransportError, type Transport } from '../sync/protocol';
import { MemoryOpStore } from '../sync/store';

export interface DemoPhone {
  owner: string;
  engine: SyncEngine;
  setOnline(online: boolean): void;
}

/** The real engine and the real server logic; only the wire between them is fake. */
export function createDemo(owners: string[] = ['Ada', 'Ben'], latencyMs = 250): DemoPhone[] {
  let ids = 0;
  const newId = () => `demo-${String(++ids).padStart(8, '0')}`;
  const service = new SyncService(new MemoryLog('demo'));
  const phones = owners.map((owner): DemoPhone => {
    let online = true;
    const call = async <T>(request: () => T): Promise<T> => {
      await new Promise((r) => setTimeout(r, latencyMs));
      if (!online) throw new TransportError('network', 'offline');
      return request();
    };
    const transport: Transport = {
      push: async (ops) => {
        const response = await call(() => service.push('demo', ops));
        nudgeOthers(owner);
        return response;
      },
      pull: (after) => call(() => service.pull('demo', after)),
    };
    const engine = new SyncEngine({ store: new MemoryOpStore(), transport, newId, newDeviceId: () => owner.toLowerCase().padEnd(4, '0') });
    return {
      owner,
      engine,
      setOnline(next) {
        online = next;
        void engine.sync();
      },
    };
  });
  /** Stands in for the native app's 30 second poll, so the demo feels live. */
  function nudgeOthers(owner: string) {
    for (const p of phones) if (p.owner !== owner) void p.engine.sync();
  }
  const [ada] = phones;
  ada!.engine.create({ type: 'feed', at: Date.now() - 40 * 60_000, amountMl: 120, by: ada!.owner });
  return phones;
}

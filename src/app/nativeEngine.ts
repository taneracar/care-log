import { randomUUID } from 'expo-crypto';
import { openDatabaseSync } from 'expo-sqlite';
import { SyncEngine } from '../sync/engine';
import { HttpTransport } from '../sync/httpTransport';
import { SqlOpStore, type SqlDriver } from '../sync/sqlStore';

/**
 * The sync API is deliberate: a write is one row, and "saved" must be true before the button
 * handler returns, or a kill right after the tap could lose the entry.
 */
function expoDriver(): SqlDriver {
  const db = openDatabaseSync('care-log.db');
  return {
    exec: (sql) => db.execSync(sql),
    run: (sql, params) => db.runSync(sql, params).changes,
    all: <T>(sql: string, params: (string | number | null)[]) => db.getAllSync<T>(sql, params),
  };
}

export function createNativeEngine(): SyncEngine {
  const baseUrl = process.env.EXPO_PUBLIC_SYNC_URL;
  const token = process.env.EXPO_PUBLIC_SYNC_TOKEN;
  return new SyncEngine({
    store: new SqlOpStore(expoDriver()),
    transport: baseUrl && token ? new HttpTransport({ baseUrl, token }) : null,
    newId: () => randomUUID(),
    newDeviceId: () => randomUUID().replaceAll('-', '').slice(0, 12),
  });
}

import { createHttpServer } from './http';
import { SyncService } from './service';
import { SqliteLog } from './sqliteLog';

// TOKENS="token-one:household-a,token-two:household-b"
const tokens = new Map<string, string>(
  (process.env.TOKENS ?? '')
    .split(',')
    .filter(Boolean)
    .map((pair: string): [string, string] => {
      const [token, household] = pair.split(':');
      if (!token || !household) throw new Error('TOKENS must look like token:household,token:household');
      return [token, household];
    }),
);
if (tokens.size === 0) throw new Error('set TOKENS=token:household');
const port = Number(process.env.PORT ?? 4020);
const log = new SqliteLog(process.env.DB ?? 'care-log.sqlite');
const server = createHttpServer(new SyncService(log), tokens).listen(port, () => {
  const address = server.address();
  console.log(`sync server on :${typeof address === 'object' && address ? address.port : port}`);
});

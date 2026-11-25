import { createHash, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { MAX_BATCH } from '../src/sync/protocol';
import type { SyncService } from './service';

const MAX_BODY_BYTES = 2 * 1024 * 1024;

class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

/** `tokens` maps bearer token → household. The client never names its own household. */
export function createHttpServer(service: SyncService, tokens: Map<string, string>): Server {
  return createServer(async (req, res) => {
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    try {
      const url = new URL(req.url ?? '/', 'http://localhost');
      if (url.pathname === '/health') return send(200, { ok: true });
      if (url.pathname !== '/v1/ops') throw new HttpError(404, 'not found');
      const household = authenticate(req, tokens);
      if (req.method === 'GET') {
        const after = Number(url.searchParams.get('after') ?? '0');
        if (!Number.isSafeInteger(after) || after < 0) throw new HttpError(400, 'bad cursor');
        return send(200, service.pull(household, after));
      }
      if (req.method === 'POST') {
        const body = await readJson(req);
        const ops = (body as { ops?: unknown } | null)?.ops;
        if (!Array.isArray(ops) || ops.length > MAX_BATCH) throw new HttpError(400, `ops must be at most ${MAX_BATCH}`);
        return send(200, service.push(household, ops));
      }
      throw new HttpError(405, 'method not allowed');
    } catch (e) {
      if (e instanceof HttpError) return send(e.status, { error: e.message });
      console.error(e);
      return send(500, { error: 'internal error' });
    }
  });
}

function authenticate(req: IncomingMessage, tokens: Map<string, string>): string {
  const given = sha(/^Bearer (.+)$/.exec(req.headers.authorization ?? '')?.[1] ?? '');
  for (const [token, household] of tokens) if (timingSafeEqual(sha(token), given)) return household;
  throw new HttpError(401, 'unknown token');
}
const sha = (s: string) => createHash('sha256').update(s).digest();

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new HttpError(413, 'body too large');
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HttpError(400, 'body is not JSON');
  }
}

import type { z } from 'zod';
import type { Op } from '../core/ops';
import { pullResponseSchema, pushResponseSchema, TransportError, type Transport } from './protocol';

export interface HttpOptions {
  baseUrl: string;
  token: string;
  timeoutMs?: number;
  fetch?: typeof fetch;
}

export class HttpTransport implements Transport {
  constructor(private readonly opts: HttpOptions) {}

  push(ops: Op[]) {
    return this.call('/v1/ops', pushResponseSchema, { method: 'POST', body: JSON.stringify({ ops }) });
  }
  pull(after: number) {
    return this.call(`/v1/ops?after=${after}`, pullResponseSchema, { method: 'GET' });
  }

  private async call<T>(path: string, schema: z.ZodType<T>, init: RequestInit): Promise<T> {
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), this.opts.timeoutMs ?? 15_000);
    let status: number;
    let retryAfter: string | null;
    let body: unknown;
    try {
      const res = await (this.opts.fetch ?? fetch)(this.opts.baseUrl + path, {
        ...init,
        signal: abort.signal,
        headers: { authorization: `Bearer ${this.opts.token}`, 'content-type': 'application/json' },
      });
      status = res.status;
      retryAfter = res.headers.get('retry-after');
      // The timeout also covers the body: a captive portal can send headers and then stall.
      const text = await res.text();
      try {
        body = JSON.parse(text);
      } catch {
        body = undefined;
      }
    } catch (e) {
      throw new TransportError('network', e instanceof Error ? e.message : String(e));
    } finally {
      clearTimeout(timer);
    }
    if (status === 401 || status === 403) throw new TransportError('auth', `refused (${status})`);
    if (status < 200 || status > 299) {
      const seconds = Number(retryAfter);
      throw new TransportError('server', `status ${status}`, seconds > 0 ? seconds * 1000 : undefined);
    }
    const parsed = schema.safeParse(body);
    if (!parsed.success) throw new TransportError('protocol', 'unexpected response shape');
    return parsed.data;
  }
}

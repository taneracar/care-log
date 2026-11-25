import { z } from 'zod';
import { opSchema, type Op } from '../core/ops';

export const MAX_BATCH = 100;
/** How far ahead of the server a stamp may be before the server sends it back to be restamped. */
export const MAX_AHEAD_MS = 5 * 60_000;

export const pushResultSchema = z.object({
  id: z.string(),
  status: z.enum(['accepted', 'duplicate', 'clock_ahead', 'invalid', 'id_reused']),
  reason: z.string().optional(),
});
export type PushResult = z.infer<typeof pushResultSchema>;

export const pushResponseSchema = z.object({
  /** Identifies this copy of the server's log. Changes when the log is lost or restored. */
  epoch: z.string(),
  serverTime: z.number(),
  results: z.array(pushResultSchema),
});
export type PushResponse = z.infer<typeof pushResponseSchema>;

export const pullResponseSchema = z.object({
  epoch: z.string(),
  ops: z.array(z.object({ seq: z.number().int().positive(), op: opSchema })),
  cursor: z.number().int().nonnegative(),
  hasMore: z.boolean(),
});
export type PullResponse = z.infer<typeof pullResponseSchema>;

export interface Transport {
  push(ops: Op[]): Promise<PushResponse>;
  pull(after: number): Promise<PullResponse>;
}

export class TransportError extends Error {
  constructor(
    readonly kind: 'network' | 'server' | 'auth' | 'protocol',
    message: string,
    readonly retryAfterMs?: number,
  ) {
    super(message);
  }
}

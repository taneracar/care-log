import { z } from 'zod';
import { STAMP_RE } from './hlc';

/** Unix ms between 2001 and 2286, i.e. 13 digits. Anything else is a bug or a broken clock. */
const instant = z.number().int().min(1_000_000_000_000).max(9_999_999_999_999);

export const FIELD_SCHEMAS = {
  type: z.enum(['feed', 'diaper', 'sleep']),
  at: instant,
  /** Sleep only. null while the nap is still running. */
  endAt: instant.nullable(),
  /** Feed only, whole millilitres. */
  amountMl: z.number().int().min(0).max(500),
  diaper: z.enum(['wet', 'dirty', 'both']),
  note: z.string().max(500),
  by: z.string().min(1).max(40),
} as const;

export type FieldName = keyof typeof FIELD_SCHEMAS;
export const FIELD_NAMES = Object.keys(FIELD_SCHEMAS) as FieldName[];
export type Fields = { [K in FieldName]?: z.infer<(typeof FIELD_SCHEMAS)[K]> };
export type FieldValue = string | number | null;

const stamp = z.string().regex(STAMP_RE);
const id = z.string().regex(/^[0-9a-zA-Z-]{8,64}$/);
const fieldsSchema = z
  .strictObject(FIELD_SCHEMAS)
  .partial()
  .refine((f) => Object.keys(f).length > 0, 'at least one field');
const basesSchema = z.partialRecord(
  z.enum(FIELD_NAMES as [FieldName, ...FieldName[]]),
  z.array(stamp).max(50),
);

/** Which writes of each field the author had on screen when they acted. */
export type Bases = { [K in FieldName]?: string[] };

export const opSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('set'), id, recordId: id, stamp, fields: fieldsSchema, base: basesSchema }),
  z.strictObject({ kind: z.literal('delete'), id, recordId: id, stamp, seen: basesSchema }),
]);
export type Op = z.infer<typeof opSchema>;

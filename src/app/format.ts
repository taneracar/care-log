import type { FieldName, FieldValue } from '../core/ops';
import type { RecordView } from '../core/record';

export const clockTime = (ms: number) =>
  new Date(ms).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });

export function duration(ms: number): string {
  const min = Math.max(0, Math.floor(ms / 60_000));
  return min < 60 ? `${min} min` : `${Math.floor(min / 60)} h ${min % 60} min`;
}

export const DIAPER = { wet: 'Wet', dirty: 'Dirty', both: 'Wet and dirty' } as const;

export function title({ fields: f }: RecordView): string {
  if (f.type === 'feed') return `Feed · ${f.amountMl ?? 0} ml`;
  if (f.type === 'diaper') return `Diaper · ${DIAPER[f.diaper ?? 'wet']}`;
  if (f.endAt == null) return 'Sleeping';
  return `Sleep · ${duration(f.endAt - f.at!)}`;
}

export const FIELD_LABEL: Record<FieldName, string> = {
  type: 'Type', at: 'Time', endAt: 'Wake time', amountMl: 'Amount', diaper: 'Diaper', note: 'Note', by: 'Logged by',
};

export function showValue(field: FieldName, value: FieldValue): string {
  if (field === 'amountMl') return `${value} ml`;
  if (field === 'endAt' && value === null) return 'Still asleep';
  if (field === 'at' || field === 'endAt') return clockTime(value as number);
  if (field === 'diaper') return DIAPER[value as keyof typeof DIAPER];
  return value === '' ? 'Empty' : String(value);
}

/**
 * Hybrid logical clock. A stamp is a string that sorts lexicographically:
 *   <13-digit ms>-<4-digit base36 counter>-<device id>
 * The stamp only decides which of two CONCURRENT values is shown first. Whether two
 * writes are concurrent at all is decided by causal `base` sets, never by clocks.
 */
export type Stamp = string;

const MAX_COUNTER = 36 ** 4 - 1;
export const STAMP_RE = /^\d{13}-[0-9a-z]{4}-[0-9a-z]{4,32}$/;

export function parseStamp(stamp: Stamp): { ms: number; counter: number; device: string } {
  if (!STAMP_RE.test(stamp)) throw new Error(`bad stamp: ${stamp}`);
  const [ms, counter, device] = stamp.split('-') as [string, string, string];
  return { ms: Number(ms), counter: parseInt(counter, 36), device };
}

export function formatStamp(ms: number, counter: number, device: string): Stamp {
  return `${String(ms).padStart(13, '0')}-${counter.toString(36).padStart(4, '0')}-${device}`;
}

export class Hlc {
  private ms = 0;
  private counter = 0;

  constructor(
    readonly device: string,
    private readonly wallClock: () => number,
  ) {}

  /** A stamp greater than every stamp this device has issued or observed. */
  next(): Stamp {
    const wall = Math.floor(this.wallClock());
    if (wall > this.ms) {
      this.ms = wall;
      this.counter = 0;
    } else if (this.counter === MAX_COUNTER) {
      this.ms += 1;
      this.counter = 0;
    } else {
      this.counter += 1;
    }
    return formatStamp(this.ms, this.counter, this.device);
  }

  observe(stamp: Stamp): void {
    const { ms, counter } = parseStamp(stamp);
    if (ms > this.ms || (ms === this.ms && counter > this.counter)) {
      this.ms = ms;
      this.counter = counter;
    }
  }
}

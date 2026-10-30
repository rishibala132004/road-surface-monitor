/**
 * Replays a recorded .jsonl log (one {"topic", "payload", "t"} object per
 * line) at 1x, 2x, 5x or 10x, with pause and seek. Timestamps inside the
 * payloads are kept as recorded, so the ride appears at its original time.
 */
import { BaseSource } from './DataSource';

export interface ReplayRecord {
  topic: string;
  payload: string;
  /** Receipt time in ms (from the log, or derived from the payload ts). */
  t: number;
}

/** Parses a .jsonl log. Tolerates payloads stored as objects or strings. */
export function parseJsonl(text: string): ReplayRecord[] {
  const out: ReplayRecord[] = [];
  let fallbackT = 0;
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const obj = JSON.parse(trimmed) as Record<string, unknown>;
      const topic = typeof obj.topic === 'string' ? obj.topic : '';
      if (!topic) continue;
      const payloadRaw = obj.payload;
      const payload =
        typeof payloadRaw === 'string' ? payloadRaw : JSON.stringify(payloadRaw ?? {});
      let t =
        typeof obj.t === 'number'
          ? obj.t
          : typeof obj.receivedAt === 'number'
            ? obj.receivedAt
            : NaN;
      if (!Number.isFinite(t)) {
        try {
          const inner = JSON.parse(payload) as Record<string, unknown>;
          const ts = inner.ts ?? inner.tst;
          t = typeof ts === 'number' ? (ts < 1e11 ? ts * 1000 : ts) : NaN;
        } catch {
          t = NaN;
        }
      }
      if (!Number.isFinite(t)) t = fallbackT + 1000;
      fallbackT = t;
      out.push({ topic, payload, t });
    } catch {
      /* skip malformed line */
    }
  }
  out.sort((a, b) => a.t - b.t);
  return out;
}

export class ReplaySource extends BaseSource {
  readonly kind = 'replay' as const;
  speed = 1;
  private index = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private paused = false;
  /** Wall-clock anchor: at wallAt, log time was logAt. */
  private wallAt = 0;
  private logAt = 0;

  constructor(
    public readonly records: ReplayRecord[],
    public readonly name = 'log',
  ) {
    super();
  }

  get duration(): number {
    if (!this.records.length) return 0;
    return this.records[this.records.length - 1]!.t - this.records[0]!.t;
  }

  get position(): number {
    const first = this.records[0]?.t ?? 0;
    return (this.records[this.index]?.t ?? first + this.duration) - first;
  }

  get isPaused(): boolean {
    return this.paused;
  }

  start(): void {
    if (!this.records.length) {
      this.setStatus('ended', 'Empty log');
      return;
    }
    this.index = 0;
    this.anchor(this.records[0]!.t);
    this.paused = false;
    this.setStatus('running');
    this.schedule();
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.setStatus('idle');
  }

  setSpeed(speed: number): void {
    this.anchor(this.currentLogTime());
    this.speed = speed;
  }

  setPaused(paused: boolean): void {
    if (paused === this.paused) return;
    if (!paused) this.anchor(this.currentLogTime());
    this.paused = paused;
    this.setStatus(paused ? 'paused' : 'running');
    if (!paused) this.schedule();
  }

  /** Jumps to an offset (ms from the start of the log). Earlier records are re-emitted instantly. */
  seek(offsetMs: number, onRewind?: () => void): void {
    const first = this.records[0]?.t ?? 0;
    const target = first + Math.max(0, Math.min(this.duration, offsetMs));
    if (target < this.currentLogTime()) {
      onRewind?.();
      this.index = 0;
    }
    while (this.index < this.records.length && this.records[this.index]!.t <= target) {
      const r = this.records[this.index]!;
      this.emitMessage(r.topic, r.payload, r.t);
      this.index++;
    }
    this.anchor(target);
    if (!this.paused) this.schedule();
  }

  private anchor(logTime: number): void {
    this.wallAt = performance.now();
    this.logAt = logTime;
  }

  private currentLogTime(): number {
    if (this.paused) return this.logAt;
    return this.logAt + (performance.now() - this.wallAt) * this.speed;
  }

  private schedule(): void {
    if (this.timer) clearTimeout(this.timer);
    const next = this.records[this.index];
    if (!next) {
      this.setStatus('ended', 'End of log');
      return;
    }
    const delay = Math.max(0, (next.t - this.currentLogTime()) / this.speed);
    this.timer = setTimeout(() => this.tick(), Math.min(delay, 1000));
  }

  private tick(): void {
    if (this.paused) return;
    const nowLog = this.currentLogTime();
    while (this.index < this.records.length && this.records[this.index]!.t <= nowLog) {
      const r = this.records[this.index]!;
      this.emitMessage(r.topic, r.payload, Date.now());
      this.index++;
    }
    this.schedule();
  }
}

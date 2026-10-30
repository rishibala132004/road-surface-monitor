/**
 * The single state store. Every data source feeds normalised messages in
 * through `ingest`; components read device state and derived statistics
 * out. Nothing else in the app keeps its own copy of the ride.
 *
 * Time model: `viewTs` is null while live (the newest sample is shown) or
 * a timestamp while the user scrubs the timeline. Components call
 * `sampleAt(device, ts)` so they follow whichever applies.
 */
import type { ConditionMessage, GpsMessage, Message, StatusMessage } from './contract';
import { GpsBuffer, type JoinedPosition } from './join';
import type { AppConfig } from '../config/types';
import { Emitter } from '../utils/events';
import { haversine } from '../utils/geo';

export interface Sample {
  ts: number;
  receivedAt: number;
  label: string;
  rawLabel: string;
  known: boolean;
  confidence: number;
  lowConfidence: boolean;
  scores?: Record<string, number>;
  /** m/s^2. Falls back to the class level when the message has none. */
  vib: number;
  vibMeasured: boolean;
  inferenceMs?: number;
  seq?: number;
  /** Joined position, when a GPS fix was close enough in time. */
  pos: JoinedPosition | null;
  /** Cumulative distance along the ride at this sample, metres. */
  distanceM: number;
  /** km/h, from the joined position. */
  speed: number | null;
  /** Receipt latency ts -> receivedAt, ms (meaningful for live data only). */
  latencyMs: number;
}

export interface LabelShare {
  id: string;
  /** Fraction of samples. */
  share: number;
  /** Metres attributed to this label. */
  metres: number;
  count: number;
}

export interface DeviceStats {
  distanceM: number;
  movingTimeMs: number;
  elapsedMs: number;
  avgSpeed: number | null;
  maxSpeed: number | null;
  stops: number;
  bumps: number;
  bumpsPerKm: number;
  roughM: number;
  smoothM: number;
  shares: LabelShare[];
  comfort: number | null;
  received: number;
  lost: number;
  /** Messages per second over the last 10 s. */
  rateHz: number;
  lastInferenceMs: number | null;
  lastLatencyMs: number | null;
  hasElevation: boolean;
}

export interface DeviceState {
  id: string;
  /** Colour slot 1..4 (cycles). */
  slot: number;
  samples: Sample[];
  gps: GpsBuffer;
  status: StatusMessage | null;
  lastConditionAt: number;
  lastGpsAt: number;
  firstTs: number;
  lastTs: number;
  stats: DeviceStats;
  /** Bump events (consecutive bump samples merged), with positions when known. */
  bumps: Sample[];
  /** Recent receipt times for the rate estimate. */
  recent: number[];
  lastSeq: number | null;
}

export interface RawRecord {
  topic: string;
  payload: string;
  receivedAt: number;
}

export type SourceKind = 'simulated' | 'live' | 'replay';

type StoreEvents = {
  condition: { device: DeviceState; sample: Sample };
  gps: { device: DeviceState; fix: GpsMessage };
  status: { device: DeviceState; status: StatusMessage };
  bump: { device: DeviceState; sample: Sample };
  'device-added': DeviceState;
  'device-selected': DeviceState | null;
  reset: void;
  view: number | null;
  'source-kind': SourceKind;
};

const RATE_WINDOW_MS = 10_000;
const MAX_SAMPLES = 20_000;

function emptyStats(): DeviceStats {
  return {
    distanceM: 0,
    movingTimeMs: 0,
    elapsedMs: 0,
    avgSpeed: null,
    maxSpeed: null,
    stops: 0,
    bumps: 0,
    bumpsPerKm: 0,
    roughM: 0,
    smoothM: 0,
    shares: [],
    comfort: null,
    received: 0,
    lost: 0,
    rateHz: 0,
    lastInferenceMs: null,
    lastLatencyMs: null,
    hasElevation: false,
  };
}

export class RideStore extends Emitter<StoreEvents> {
  readonly devices = new Map<string, DeviceState>();
  selectedId: string | null = null;
  viewTs: number | null = null;
  sourceKind: SourceKind = 'simulated';
  records: RawRecord[] = [];
  /** Running counters per label for the statistics. */
  private labelCounts = new Map<string, Map<string, { count: number; metres: number }>>();

  constructor(private cfg: AppConfig) {
    super();
  }

  setConfig(cfg: AppConfig): void {
    this.cfg = cfg;
    for (const d of this.devices.values()) this.recomputeStats(d);
  }

  get config(): AppConfig {
    return this.cfg;
  }

  // ---------------------------------------------------------------- devices

  get selected(): DeviceState | null {
    return this.selectedId ? (this.devices.get(this.selectedId) ?? null) : null;
  }

  get deviceList(): DeviceState[] {
    return [...this.devices.values()];
  }

  select(id: string | null): void {
    if (id === this.selectedId) return;
    this.selectedId = id;
    this.emit('device-selected', this.selected);
  }

  device(id: string): DeviceState {
    let d = this.devices.get(id);
    if (!d) {
      d = {
        id,
        slot: (this.devices.size % 4) + 1,
        samples: [],
        gps: new GpsBuffer(),
        status: null,
        lastConditionAt: 0,
        lastGpsAt: 0,
        firstTs: 0,
        lastTs: 0,
        stats: emptyStats(),
        bumps: [],
        recent: [],
        lastSeq: null,
      };
      this.devices.set(id, d);
      this.labelCounts.set(id, new Map());
      this.emit('device-added', d);
      if (!this.selectedId) this.select(id);
    }
    return d;
  }

  // ---------------------------------------------------------------- ingest

  /** Records the raw message (for export) and routes it by kind. */
  ingest(msg: Message, raw?: { topic: string; payload: string }): void {
    if (raw) {
      this.records.push({ topic: raw.topic, payload: raw.payload, receivedAt: msg.receivedAt });
      if (this.records.length > 200_000) this.records.splice(0, 50_000);
    }
    switch (msg.kind) {
      case 'condition':
        this.ingestCondition(msg);
        break;
      case 'gps':
        this.ingestGps(msg);
        break;
      case 'status':
        this.ingestStatus(msg);
        break;
    }
  }

  private ingestGps(fix: GpsMessage): void {
    const d = this.device(fix.device);
    d.gps.push(fix);
    d.lastGpsAt = fix.receivedAt;
    if (fix.alt != null) d.stats.hasElevation = true;
    // Conditions that arrived before this fix may now be joinable.
    const windowMs = this.cfg.joinWindowMs;
    for (let i = d.samples.length - 1; i >= 0; i--) {
      const s = d.samples[i]!;
      if (fix.ts - s.ts > windowMs * 2) break;
      if (!s.pos) {
        s.pos = d.gps.locate(s.ts, windowMs);
        if (s.pos) s.speed = s.pos.speed ?? s.speed;
      }
    }
    this.recomputeStats(d);
    this.emit('gps', { device: d, fix });
  }

  private ingestStatus(status: StatusMessage): void {
    const d = this.device(status.device);
    d.status = status;
    this.emit('status', { device: d, status });
  }

  private ingestCondition(msg: ConditionMessage): void {
    const d = this.device(msg.device);
    const cls = this.cfg.classes.find((c) => c.id === msg.label);
    let pos: JoinedPosition | null;
    if (msg.lat != null && msg.lon != null) {
      pos = { lat: msg.lat, lon: msg.lon, ageMs: 0, interpolated: false };
      const near = d.gps.locate(msg.ts, this.cfg.joinWindowMs);
      if (near) {
        pos.speed = near.speed;
        pos.heading = near.heading;
      }
    } else {
      pos = d.gps.locate(msg.ts, this.cfg.joinWindowMs);
    }
    const prev = d.samples[d.samples.length - 1];
    const sample: Sample = {
      ts: msg.ts,
      receivedAt: msg.receivedAt,
      label: msg.label,
      rawLabel: msg.rawLabel,
      known: msg.known,
      confidence: msg.confidence,
      lowConfidence: msg.confidence < this.cfg.lowConfidence,
      scores: msg.scores,
      vib: msg.vib ?? cls?.vibLevel ?? 0,
      vibMeasured: msg.vib != null,
      inferenceMs: msg.inferenceMs,
      seq: msg.seq,
      pos,
      distanceM: this.distanceAt(d, msg.ts),
      speed: pos?.speed ?? null,
      latencyMs: Math.max(0, msg.receivedAt - msg.ts),
    };

    // Lost-message detection from the sequence counter.
    if (msg.seq != null) {
      if (d.lastSeq != null && msg.seq > d.lastSeq + 1 && msg.seq - d.lastSeq < 10_000) {
        d.stats.lost += msg.seq - d.lastSeq - 1;
      }
      d.lastSeq = msg.seq;
    }

    d.samples.push(sample);
    if (d.samples.length > MAX_SAMPLES) d.samples.splice(0, d.samples.length - MAX_SAMPLES);
    if (!d.firstTs) d.firstTs = msg.ts;
    d.lastTs = Math.max(d.lastTs, msg.ts);
    d.lastConditionAt = msg.receivedAt;
    d.stats.received++;
    d.recent.push(msg.receivedAt);
    if (msg.inferenceMs != null) d.stats.lastInferenceMs = msg.inferenceMs;
    d.stats.lastLatencyMs = sample.latencyMs;

    // Label counters: metres credited to the previous sample's label.
    const counts = this.labelCounts.get(d.id)!;
    const entry = counts.get(sample.label) ?? { count: 0, metres: 0 };
    entry.count++;
    counts.set(sample.label, entry);
    if (prev) {
      const prevEntry = counts.get(prev.label);
      if (prevEntry) prevEntry.metres += Math.max(0, sample.distanceM - prev.distanceM);
    }

    // Bump events: merge consecutive bump windows within 2.5 s.
    if (sample.label === 'bump') {
      const last = d.bumps[d.bumps.length - 1];
      if (!last || sample.ts - last.ts > 2500) {
        d.bumps.push(sample);
        this.emit('bump', { device: d, sample });
      }
    }

    this.recomputeStats(d);
    this.emit('condition', { device: d, sample });
  }

  // ---------------------------------------------------------------- queries

  /** Cumulative ride distance at time t, from the GPS track. */
  private distanceAt(d: DeviceState, t: number): number {
    const fixes = d.gps.all();
    if (!fixes.length) return d.samples[d.samples.length - 1]?.distanceM ?? 0;
    // Walk forward from the last computed sample to keep this O(1) amortised.
    const last = d.samples[d.samples.length - 1];
    let dist = last?.distanceM ?? 0;
    let fromTs = last?.ts ?? fixes[0]?.ts ?? t;
    if (t < fromTs) return dist;
    let prev: GpsMessage | null = null;
    for (const f of fixes) {
      if (f.ts <= fromTs) {
        prev = f;
        continue;
      }
      if (f.ts > t) break;
      if (prev) dist += this.stepDistance(prev, f);
      prev = f;
      fromTs = f.ts;
    }
    return dist;
  }

  /** Distance between two fixes, suppressing GPS jitter while stopped. */
  private stepDistance(a: GpsMessage, b: GpsMessage): number {
    const metres = haversine([a.lon, a.lat], [b.lon, b.lat]);
    const speed = b.speed ?? a.speed;
    if (speed != null && speed < 2) return 0;
    if (speed == null && metres < 4) return 0;
    const dtS = Math.max(0.001, (b.ts - a.ts) / 1000);
    if (metres / dtS > 25) return 0; // > 90 km/h on a bicycle: a glitch
    return metres;
  }

  /** Last sample at or before t (or the newest when t is null). */
  sampleAt(d: DeviceState, t: number | null): Sample | null {
    const s = d.samples;
    if (!s.length) return null;
    if (t == null) return s[s.length - 1]!;
    let lo = 0;
    let hi = s.length - 1;
    if ((s[0]?.ts ?? 0) > t) return null;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if ((s[mid]?.ts ?? 0) <= t) lo = mid;
      else hi = mid - 1;
    }
    return s[lo] ?? null;
  }

  /** Index of the last sample at or before t. */
  indexAt(d: DeviceState, t: number): number {
    const s = this.sampleAt(d, t);
    return s ? d.samples.indexOf(s) : -1;
  }

  /** Position for an arbitrary time: joined sample position or GPS buffer. */
  positionAt(d: DeviceState, t: number | null): JoinedPosition | null {
    if (t == null) {
      const latest = d.gps.latest;
      const last = d.samples[d.samples.length - 1];
      if (latest && (!last?.pos || latest.ts >= last.ts)) {
        return {
          lat: latest.lat,
          lon: latest.lon,
          speed: latest.speed,
          heading: latest.heading,
          acc: latest.acc,
          alt: latest.alt,
          ageMs: 0,
          interpolated: false,
        };
      }
      return last?.pos ?? null;
    }
    return d.gps.locate(t, this.cfg.joinWindowMs * 2) ?? this.sampleAt(d, t)?.pos ?? null;
  }

  /** Ride time range across all devices (ms). */
  get timeRange(): { start: number; end: number } | null {
    let start = Infinity;
    let end = -Infinity;
    for (const d of this.devices.values()) {
      if (d.firstTs) start = Math.min(start, d.firstTs);
      if (d.lastTs) end = Math.max(end, d.lastTs);
    }
    return Number.isFinite(start) && Number.isFinite(end) ? { start, end } : null;
  }

  get isLive(): boolean {
    return this.viewTs == null;
  }

  setView(ts: number | null): void {
    const range = this.timeRange;
    if (ts != null && range) {
      if (ts >= range.end - 50) ts = null;
      else ts = Math.max(range.start, ts);
    }
    if (ts === this.viewTs) return;
    this.viewTs = ts;
    this.emit('view', ts);
  }

  setSourceKind(kind: SourceKind): void {
    if (kind === this.sourceKind) return;
    this.sourceKind = kind;
    this.emit('source-kind', kind);
  }

  /** Drops all ride data (devices, samples, records). */
  reset(): void {
    this.devices.clear();
    this.labelCounts.clear();
    this.records = [];
    this.selectedId = null;
    this.viewTs = null;
    this.emit('reset', undefined);
    this.emit('device-selected', null);
  }

  // ---------------------------------------------------------------- stats

  /** Recomputes the derived statistics for one device. Cheap: counters only. */
  recomputeStats(d: DeviceState): void {
    const st = d.stats;
    const counts = this.labelCounts.get(d.id) ?? new Map();
    const total = [...counts.values()].reduce((a, c) => a + c.count, 0);
    st.shares = this.cfg.classes.map((c) => {
      const e = counts.get(c.id);
      return {
        id: c.id,
        count: e?.count ?? 0,
        metres: e?.metres ?? 0,
        share: total ? (e?.count ?? 0) / total : 0,
      };
    });
    for (const [id, e] of counts) {
      if (!this.cfg.classes.some((c) => c.id === id)) {
        st.shares.push({
          id,
          count: e.count,
          metres: e.metres,
          share: total ? e.count / total : 0,
        });
      }
    }
    st.roughM = counts.get('rough')?.metres ?? 0;
    st.smoothM = counts.get('smooth')?.metres ?? 0;

    const last = d.samples[d.samples.length - 1];
    st.distanceM = last?.distanceM ?? 0;
    st.elapsedMs = d.firstTs && d.lastTs ? d.lastTs - d.firstTs : 0;

    // Moving time, stops and max speed from the sample sequence.
    let moving = 0;
    let stops = 0;
    let stoppedRun = 0;
    let maxSpeed = 0;
    for (let i = 0; i < d.samples.length; i++) {
      const s = d.samples[i]!;
      const next = d.samples[i + 1];
      const dt = next ? Math.min(3000, Math.max(0, next.ts - s.ts)) : 1000;
      if (s.label === 'stopped') {
        stoppedRun += dt;
      } else {
        if (stoppedRun >= 3000) stops++;
        stoppedRun = 0;
        moving += dt;
      }
      if (s.speed != null && s.speed < 70) maxSpeed = Math.max(maxSpeed, s.speed);
    }
    if (stoppedRun >= 3000) stops++;
    st.movingTimeMs = moving;
    st.stops = stops;
    st.maxSpeed = d.samples.length ? maxSpeed : null;
    st.avgSpeed = moving > 0 ? st.distanceM / 1000 / (moving / 3_600_000) : null;

    st.bumps = d.bumps.length;
    const km = st.distanceM / 1000;
    st.bumpsPerKm = km > 0.05 ? st.bumps / km : 0;

    // Comfort score. Stops are left out of the denominator.
    const { smoothWeight, roughWeight, bumpPenaltyPerKm } = this.cfg.comfort;
    const sm = counts.get('smooth')?.count ?? 0;
    const ro = counts.get('rough')?.count ?? 0;
    const bu = counts.get('bump')?.count ?? 0;
    const denom = sm + ro + bu;
    if (denom > 0) {
      const base = ((smoothWeight * sm + roughWeight * ro) / denom) * 100;
      st.comfort = Math.max(0, Math.min(100, base - bumpPenaltyPerKm * st.bumpsPerKm));
    } else st.comfort = null;

    // Message rate over the last 10 s of receipt time.
    const nowMs = last?.receivedAt ?? Date.now();
    while (d.recent.length && nowMs - (d.recent[0] ?? 0) > RATE_WINDOW_MS) d.recent.shift();
    st.rateHz = d.recent.length / (RATE_WINDOW_MS / 1000);
  }

  /** Explains the comfort formula with the current weights (for the hover text). */
  comfortFormula(): string {
    const { smoothWeight, roughWeight, bumpPenaltyPerKm } = this.cfg.comfort;
    return (
      `Comfort = 100 x (${smoothWeight} x smooth + ${roughWeight} x rough) / (smooth + rough + bump) ` +
      `- ${bumpPenaltyPerKm} x bumps per km. Stopped windows are left out.`
    );
  }
}

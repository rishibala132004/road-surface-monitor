/**
 * The data contract: message types and a tolerant parser.
 *
 * Every data source (simulator, MQTT, replay) hands raw (topic, payload)
 * pairs to `parseMessage`, which returns one of three normalised messages
 * or null. The rest of the app only ever sees the normalised form.
 *
 * Tolerance rules (see docs/DATA_CONTRACT.md):
 *   - unknown fields are ignored, missing optional fields are fine;
 *   - timestamps in seconds or milliseconds are both accepted;
 *   - confidence from 0..1 or 0..100 is accepted;
 *   - labels are matched case-insensitively and through an alias table;
 *   - unknown labels are kept (flagged `known: false`) rather than dropped.
 */
import { normaliseTimestamp } from '../utils/time';

export interface ConditionMessage {
  kind: 'condition';
  device: string;
  /** Canonical class id when known, otherwise the lower-cased raw label. */
  label: string;
  rawLabel: string;
  known: boolean;
  /** 0..1 */
  confidence: number;
  /** Milliseconds since the epoch. */
  ts: number;
  /** Class probabilities keyed by canonical id, 0..1. */
  scores?: Record<string, number>;
  /** Vibration RMS in m/s^2 with gravity removed. */
  vib?: number;
  inferenceMs?: number;
  seq?: number;
  lat?: number;
  lon?: number;
  receivedAt: number;
}

export interface GpsMessage {
  kind: 'gps';
  device: string;
  lat: number;
  lon: number;
  ts: number;
  /** km/h */
  speed?: number;
  /** Horizontal accuracy in metres. */
  acc?: number;
  /** Degrees clockwise from north. */
  heading?: number;
  /** Metres above sea level, if the source provides it. */
  alt?: number;
  receivedAt: number;
}

export interface StatusMessage {
  kind: 'status';
  device: string;
  ts: number;
  battery?: number;
  model?: string;
  rateHz?: number;
  uptimeS?: number;
  receivedAt: number;
}

export type Message = ConditionMessage | GpsMessage | StatusMessage;

export interface ParseContext {
  /** First topic segment, for example "road". */
  topicPrefix: string;
  /** Canonical class ids, lower case. */
  classIds: string[];
  /** Lower-case alias -> class id. */
  aliases: Record<string, string>;
  /** "user/device" or "owntracks/user/device" -> bike id. */
  owntracksMap: Record<string, string>;
  owntracksDefaultBike: string;
  /** Time of receipt (ms). Defaults to Date.now(). */
  receivedAt?: number;
}

type Raw = Record<string, unknown>;

function asNumber(v: unknown): number | undefined {
  if (typeof v === 'number') return Number.isFinite(v) ? v : undefined;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v);
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
}

function asString(v: unknown): string | undefined {
  if (typeof v === 'string') return v;
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  return undefined;
}

function pick(raw: Raw, ...keys: string[]): unknown {
  for (const k of keys) if (raw[k] !== undefined && raw[k] !== null) return raw[k];
  return undefined;
}

/** Confidence given as 0..1 or 0..100 (or a percentage string) -> 0..1. */
export function normaliseConfidence(v: unknown, fallback = 1): number {
  let n = asNumber(typeof v === 'string' ? v.replace('%', '') : v);
  if (n === undefined) return fallback;
  if (n > 1) n = n / 100;
  return Math.min(1, Math.max(0, n));
}

/** Maps a raw label to a canonical class id, or returns it lower-cased and unknown. */
export function normaliseLabel(
  raw: unknown,
  classIds: string[],
  aliases: Record<string, string>,
): { label: string; known: boolean } {
  const text = asString(raw)?.trim().toLowerCase() ?? '';
  if (!text) return { label: 'unknown', known: false };
  if (classIds.includes(text)) return { label: text, known: true };
  const aliased = aliases[text]?.toLowerCase();
  if (aliased && classIds.includes(aliased)) return { label: aliased, known: true };
  // Loose match: "Rough road" -> rough, "BUMP_1" -> bump.
  const compact = text.replace(/[^a-z]/g, '');
  for (const id of classIds) if (compact.startsWith(id)) return { label: id, known: true };
  for (const [alias, id] of Object.entries(aliases)) {
    if (compact.startsWith(alias.replace(/[^a-z]/g, '')) && classIds.includes(id)) {
      return { label: id, known: true };
    }
  }
  return { label: text, known: false };
}

/** Normalises a scores object: canonical keys, 0..1 values. */
export function normaliseScores(
  raw: unknown,
  classIds: string[],
  aliases: Record<string, string>,
): Record<string, number> | undefined {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined;
  const entries: [string, number][] = [];
  for (const [k, v] of Object.entries(raw as Raw)) {
    const n = asNumber(v);
    if (n === undefined) continue;
    entries.push([normaliseLabel(k, classIds, aliases).label, n]);
  }
  if (!entries.length) return undefined;
  const max = Math.max(...entries.map(([, n]) => n));
  const scale = max > 1 ? 1 / 100 : 1;
  const out: Record<string, number> = {};
  for (const [k, n] of entries) out[k] = Math.min(1, Math.max(0, n * scale));
  return out;
}

export interface TopicInfo {
  kind: 'condition' | 'gps' | 'status' | 'owntracks' | 'unknown';
  device?: string;
  owntracksKey?: string;
}

/** Splits a topic into its meaning. Exported for tests and the pipeline view. */
export function parseTopic(topic: string, topicPrefix: string): TopicInfo {
  const parts = topic.split('/').filter(Boolean);
  if (parts[0] === 'owntracks' && parts.length >= 3) {
    return { kind: 'owntracks', owntracksKey: `${parts[1]}/${parts[2]}` };
  }
  if (parts[0] === topicPrefix && parts.length >= 3) {
    const kind = parts[parts.length - 1]!.toLowerCase();
    const device = parts.slice(1, -1).join('/');
    if (kind === 'condition' || kind === 'gps' || kind === 'status') return { kind, device };
    if (kind === 'location' || kind === 'position') return { kind: 'gps', device };
    if (kind === 'result' || kind === 'label' || kind === 'class')
      return { kind: 'condition', device };
  }
  return { kind: 'unknown' };
}

function parsePayload(payload: unknown): Raw | null {
  if (typeof payload === 'string') {
    try {
      const v = JSON.parse(payload);
      return typeof v === 'object' && v !== null ? (v as Raw) : null;
    } catch {
      return null;
    }
  }
  if (payload instanceof Uint8Array) return parsePayload(new TextDecoder().decode(payload));
  if (typeof payload === 'object' && payload !== null) return payload as Raw;
  return null;
}

/**
 * Parses one raw message. Returns null when the payload is not usable
 * (not JSON, no position in a GPS message, no label in a condition).
 */
export function parseMessage(topic: string, payload: unknown, ctx: ParseContext): Message | null {
  const raw = parsePayload(payload);
  if (!raw) return null;
  const receivedAt = ctx.receivedAt ?? Date.now();
  const info = parseTopic(topic, ctx.topicPrefix);

  if (info.kind === 'owntracks') {
    if (raw._type !== 'location') return null;
    const key = info.owntracksKey ?? '';
    const device =
      ctx.owntracksMap[key] ?? ctx.owntracksMap[`owntracks/${key}`] ?? ctx.owntracksDefaultBike;
    return buildGps(raw, device, receivedAt, true);
  }

  // Fall back to the payload content when the topic is not recognised.
  let kind = info.kind;
  if (kind === 'unknown') {
    if (pick(raw, 'label', 'class', 'prediction') !== undefined) kind = 'condition';
    else if (pick(raw, 'lat', 'latitude') !== undefined) kind = 'gps';
    else if (pick(raw, 'battery', 'uptime_s', 'model') !== undefined) kind = 'status';
    else return null;
  }
  const device =
    asString(pick(raw, 'device', 'id', 'bike')) ?? info.device ?? ctx.owntracksDefaultBike;

  if (kind === 'gps') return buildGps(raw, device, receivedAt, false);

  if (kind === 'status') {
    return {
      kind: 'status',
      device,
      ts: normaliseTimestamp(pick(raw, 'ts', 'timestamp', 'time'), receivedAt),
      battery: asNumber(pick(raw, 'battery', 'batt')),
      model: asString(pick(raw, 'model', 'model_name')),
      rateHz: asNumber(pick(raw, 'rate_hz', 'rate')),
      uptimeS: asNumber(pick(raw, 'uptime_s', 'uptime')),
      receivedAt,
    };
  }

  const rawLabel = asString(pick(raw, 'label', 'class', 'prediction'));
  if (rawLabel === undefined) return null;
  const { label, known } = normaliseLabel(rawLabel, ctx.classIds, ctx.aliases);
  const lat = asNumber(pick(raw, 'lat', 'latitude'));
  const lon = asNumber(pick(raw, 'lon', 'lng', 'longitude'));
  const msg: ConditionMessage = {
    kind: 'condition',
    device,
    label,
    rawLabel,
    known,
    confidence: normaliseConfidence(pick(raw, 'confidence', 'conf', 'probability', 'score')),
    ts: normaliseTimestamp(pick(raw, 'ts', 'timestamp', 'time'), receivedAt),
    receivedAt,
  };
  const scores = normaliseScores(
    pick(raw, 'scores', 'classification', 'probabilities'),
    ctx.classIds,
    ctx.aliases,
  );
  if (scores) msg.scores = scores;
  const vib = asNumber(pick(raw, 'vib', 'vibration', 'rms'));
  if (vib !== undefined) msg.vib = Math.max(0, vib);
  const inf = asNumber(pick(raw, 'inference_ms', 'inferenceMs', 'latency_ms'));
  if (inf !== undefined) msg.inferenceMs = inf;
  const seq = asNumber(pick(raw, 'seq', 'sequence', 'count'));
  if (seq !== undefined) msg.seq = Math.round(seq);
  if (lat !== undefined && lon !== undefined && validLatLon(lat, lon)) {
    msg.lat = lat;
    msg.lon = lon;
  }
  return msg;
}

function validLatLon(lat: number, lon: number): boolean {
  return Math.abs(lat) <= 90 && Math.abs(lon) <= 180 && !(lat === 0 && lon === 0);
}

function buildGps(
  raw: Raw,
  device: string,
  receivedAt: number,
  owntracks: boolean,
): GpsMessage | null {
  const lat = asNumber(pick(raw, 'lat', 'latitude'));
  const lon = asNumber(pick(raw, 'lon', 'lng', 'longitude'));
  if (lat === undefined || lon === undefined || !validLatLon(lat, lon)) return null;
  const msg: GpsMessage = {
    kind: 'gps',
    device,
    lat,
    lon,
    ts: normaliseTimestamp(
      pick(raw, owntracks ? 'tst' : 'ts', 'ts', 'tst', 'timestamp', 'time'),
      receivedAt,
    ),
    receivedAt,
  };
  // OwnTracks: vel km/h, cog heading, acc metres, alt metres.
  const speed = asNumber(pick(raw, 'speed', 'vel', 'speed_kmh'));
  if (speed !== undefined) msg.speed = Math.max(0, speed);
  const acc = asNumber(pick(raw, 'acc', 'accuracy', 'hdop'));
  if (acc !== undefined) msg.acc = acc;
  const heading = asNumber(pick(raw, 'heading', 'cog', 'bearing', 'course'));
  if (heading !== undefined && heading >= 0) msg.heading = heading % 360;
  const alt = asNumber(pick(raw, 'alt', 'altitude', 'ele'));
  if (alt !== undefined) msg.alt = alt;
  return msg;
}

/**
 * Splits a ride into short segments (about 25 m) and groups them by street
 * for the area report. Pure functions, no DOM.
 */
import type { DeviceState, Sample } from '../data/store';
import type { ComfortConfig } from '../config/types';
import { haversine, type LonLat } from '../utils/geo';

export interface Segment {
  index: number;
  t0: number;
  t1: number;
  metres: number;
  counts: Record<string, number>;
  bumps: number;
  lowConfidence: number;
  samples: number;
  /** Majority label. */
  label: string;
  coords: LonLat[];
  mid: LonLat;
  street: string;
}

export interface StreetReport {
  name: string;
  metres: number;
  shares: Record<string, number>;
  bumps: number;
  comfort: number;
  /** Majority label per segment, in ride order (for the condition strip). */
  strip: string[];
  segments: Segment[];
  bounds: [LonLat, LonLat];
}

function majority(counts: Record<string, number>): string {
  let best = 'unknown';
  let n = -1;
  for (const [k, v] of Object.entries(counts)) {
    // Bumps win ties so a bump segment stays visible.
    if (v > n || (v === n && k === 'bump')) {
      best = k;
      n = v;
    }
  }
  return best;
}

/** Cuts positioned samples into consecutive segments of roughly `lengthM`. */
export function segmentRide(
  device: DeviceState,
  lengthM: number,
  upTo: number | null = null,
): Segment[] {
  const segments: Segment[] = [];
  let cur: Segment | null = null;
  let prev: Sample | null = null;
  for (const s of device.samples) {
    if (upTo != null && s.ts > upTo) break;
    if (!s.pos) continue;
    const p: LonLat = [s.pos.lon, s.pos.lat];
    const step = prev?.pos ? haversine([prev.pos.lon, prev.pos.lat], p) : 0;
    if (
      !cur ||
      cur.metres + step > lengthM * 1.5 ||
      (cur.metres >= lengthM && s.label !== cur.label)
    ) {
      cur = {
        index: segments.length,
        t0: s.ts,
        t1: s.ts,
        metres: 0,
        counts: {},
        bumps: 0,
        lowConfidence: 0,
        samples: 0,
        label: s.label,
        coords: prev?.pos ? [[prev.pos.lon, prev.pos.lat], p] : [p],
        mid: p,
        street: '',
      };
      segments.push(cur);
    } else {
      cur.coords.push(p);
      cur.metres += step;
    }
    cur.t1 = s.ts;
    cur.samples++;
    cur.counts[s.label] = (cur.counts[s.label] ?? 0) + 1;
    if (s.label === 'bump') cur.bumps++;
    if (s.lowConfidence) cur.lowConfidence++;
    cur.label = majority(cur.counts);
    prev = s;
  }
  for (const seg of segments) {
    const m = seg.coords[Math.floor(seg.coords.length / 2)];
    if (m) seg.mid = m;
  }
  return segments;
}

export function comfortOf(
  counts: Record<string, number>,
  bumps: number,
  metres: number,
  cfg: ComfortConfig,
): number {
  const sm = counts.smooth ?? 0;
  const ro = counts.rough ?? 0;
  const bu = counts.bump ?? 0;
  const denom = sm + ro + bu;
  if (!denom) return 0;
  const base = ((cfg.smoothWeight * sm + cfg.roughWeight * ro) / denom) * 100;
  const perKm = metres > 20 ? bumps / (metres / 1000) : 0;
  return Math.max(0, Math.min(100, Math.round(base - cfg.bumpPenaltyPerKm * perKm)));
}

/** Groups segments by street name (segments without a name are grouped as "Unnamed"). */
export function groupByStreet(
  segments: Segment[],
  cfg: ComfortConfig,
  labelIds: string[],
): StreetReport[] {
  const map = new Map<string, StreetReport>();
  for (const seg of segments) {
    const name = seg.street || 'Unnamed road';
    let rep = map.get(name);
    if (!rep) {
      rep = {
        name,
        metres: 0,
        shares: {},
        bumps: 0,
        comfort: 0,
        strip: [],
        segments: [],
        bounds: [
          [seg.mid[0], seg.mid[1]],
          [seg.mid[0], seg.mid[1]],
        ],
      };
      map.set(name, rep);
    }
    rep.metres += seg.metres;
    rep.segments.push(seg);
    rep.strip.push(seg.label);
    // Bump events: consecutive bump samples are one bump, approximated by segment counts.
    rep.bumps += seg.bumps > 0 ? Math.max(1, Math.round(seg.bumps / 2)) : 0;
    for (const c of seg.coords) {
      rep.bounds[0][0] = Math.min(rep.bounds[0][0], c[0]);
      rep.bounds[0][1] = Math.min(rep.bounds[0][1], c[1]);
      rep.bounds[1][0] = Math.max(rep.bounds[1][0], c[0]);
      rep.bounds[1][1] = Math.max(rep.bounds[1][1], c[1]);
    }
  }
  const out: StreetReport[] = [];
  for (const rep of map.values()) {
    const counts: Record<string, number> = {};
    for (const seg of rep.segments)
      for (const [k, v] of Object.entries(seg.counts)) counts[k] = (counts[k] ?? 0) + v;
    const total = Object.values(counts).reduce((a, b) => a + b, 0) || 1;
    for (const id of labelIds) rep.shares[id] = (counts[id] ?? 0) / total;
    rep.comfort = comfortOf(counts, rep.bumps, rep.metres, cfg);
    out.push(rep);
  }
  // Worst first.
  out.sort((a, b) => a.comfort - b.comfort || b.metres - a.metres);
  return out;
}

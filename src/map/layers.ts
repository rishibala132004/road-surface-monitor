/**
 * Builds the GeoJSON that the map draws from the store: the ride ribbon
 * (one LineString per run of equal condition), the bump points and the
 * aggregated quality hexes. Kept separate from the MapLibre code so it can
 * be unit tested and reused by the exports.
 */
import type { DeviceState, RideStore, Sample } from '../data/store';
import { LocalGrid, hexCell, hexCentre, hexPolygon, type LonLat } from '../utils/geo';

export interface RideRunProps {
  device: string;
  slot: number;
  label: string;
  /** Line pattern of the class (solid, hatched, pin, hollow, dotted). */
  pattern: string;
  /** 1 when the run is below the confidence threshold. */
  low: number;
  /** Timestamps of the first and last sample in the run. */
  t0: number;
  t1: number;
}

export type RunFeature = GeoJSON.Feature<GeoJSON.LineString, RideRunProps>;

/**
 * Smooths consecutive positions with a three-point average. GPS jitter of a
 * few metres would otherwise draw a visibly jagged ribbon; the stored samples
 * keep their raw positions.
 */
function smoothedPositions(samples: readonly Sample[], upTo: number | null): (LonLat | null)[] {
  const raw: (LonLat | null)[] = [];
  for (const s of samples) {
    if (upTo != null && s.ts > upTo) break;
    raw.push(s.pos ? [s.pos.lon, s.pos.lat] : null);
  }
  return raw.map((p, i) => {
    if (!p) return null;
    const a = raw[i - 1];
    const b = raw[i + 1];
    if (!a || !b) return p;
    return [(a[0] + p[0] + b[0]) / 3, (a[1] + p[1] + b[1]) / 3];
  });
}

/** Groups consecutive positioned samples with the same label into runs. */
export function buildRuns(
  device: DeviceState,
  upTo: number | null = null,
  patternOf: (label: string) => string = () => 'solid',
): RunFeature[] {
  const runs: RunFeature[] = [];
  let current: RunFeature | null = null;
  let prevPoint: LonLat | null = null;
  const positions = smoothedPositions(device.samples, upTo);
  for (let i = 0; i < positions.length; i++) {
    const s = device.samples[i]!;
    const p = positions[i];
    if (!p) continue;
    const low = s.lowConfidence ? 1 : 0;
    if (current && current.properties.label === s.label && current.properties.low === low) {
      current.geometry.coordinates.push(p);
      current.properties.t1 = s.ts;
    } else {
      // Start the new run from the previous point so there is no gap.
      const coords: LonLat[] = prevPoint ? [prevPoint, p] : [p];
      current = {
        type: 'Feature',
        properties: {
          device: device.id,
          slot: device.slot,
          label: s.label,
          pattern: patternOf(s.label),
          low,
          t0: s.ts,
          t1: s.ts,
        },
        geometry: { type: 'LineString', coordinates: coords },
      };
      runs.push(current);
    }
    prevPoint = p;
  }
  // A one-point run cannot be drawn as a line; duplicate the point so it still
  // counts (MapLibre skips zero-length lines, which is fine).
  return runs.filter((r) => r.geometry.coordinates.length >= 2);
}

export interface BumpProps {
  device: string;
  slot: number;
  ts: number;
  confidence: number;
  low: number;
  vib: number;
}

export function buildBumps(
  device: DeviceState,
  upTo: number | null = null,
): GeoJSON.Feature<GeoJSON.Point, BumpProps>[] {
  const out: GeoJSON.Feature<GeoJSON.Point, BumpProps>[] = [];
  for (const b of device.bumps) {
    if (upTo != null && b.ts > upTo) break;
    if (!b.pos) continue;
    out.push({
      type: 'Feature',
      properties: {
        device: device.id,
        slot: device.slot,
        ts: b.ts,
        confidence: b.confidence,
        low: b.lowConfidence ? 1 : 0,
        vib: b.vib,
      },
      geometry: { type: 'Point', coordinates: [b.pos.lon, b.pos.lat] },
    });
  }
  return out;
}

export function rideCollection(
  store: RideStore,
  upTo: number | null = null,
): GeoJSON.FeatureCollection<GeoJSON.LineString, RideRunProps> {
  const features: RunFeature[] = [];
  const patterns = new Map(store.config.classes.map((c) => [c.id, c.pattern as string]));
  const patternOf = (label: string) => patterns.get(label) ?? 'solid';
  for (const d of store.devices.values()) features.push(...buildRuns(d, upTo, patternOf));
  return { type: 'FeatureCollection', features };
}

export function bumpCollection(
  store: RideStore,
  upTo: number | null = null,
): GeoJSON.FeatureCollection<GeoJSON.Point, BumpProps> {
  const features: GeoJSON.Feature<GeoJSON.Point, BumpProps>[] = [];
  for (const d of store.devices.values()) features.push(...buildBumps(d, upTo));
  return { type: 'FeatureCollection', features };
}

export interface HexProps {
  count: number;
  smooth: number;
  rough: number;
  bump: number;
  /** 0..100 comfort estimate for the cell. */
  comfort: number;
  rides: number;
}

/**
 * Aggregates positioned samples from any number of rides into a flat-top
 * hex grid. `comfort` follows the same idea as the ride score: smooth
 * counts 1, rough 0.5, bumps 0, scaled to 0..100.
 */
export function buildHexGrid(
  sampleSets: Sample[][],
  sizeM = 28,
  weights = { smooth: 1, rough: 0.5 },
): GeoJSON.FeatureCollection<GeoJSON.Polygon, HexProps> {
  const first = sampleSets.flat().find((s) => s.pos);
  if (!first?.pos) return { type: 'FeatureCollection', features: [] };
  const grid = new LocalGrid([first.pos.lon, first.pos.lat]);
  const cells = new Map<string, HexProps & { q: number; r: number; rideIds: Set<number> }>();
  sampleSets.forEach((samples, rideIdx) => {
    for (const s of samples) {
      if (!s.pos || s.label === 'stopped' || !s.known) continue;
      const [x, y] = grid.toXY([s.pos.lon, s.pos.lat]);
      const [q, r] = hexCell(x, y, sizeM);
      const key = `${q},${r}`;
      let cell = cells.get(key);
      if (!cell) {
        cell = {
          q,
          r,
          count: 0,
          smooth: 0,
          rough: 0,
          bump: 0,
          comfort: 0,
          rides: 0,
          rideIds: new Set(),
        };
        cells.set(key, cell);
      }
      cell.count++;
      cell.rideIds.add(rideIdx);
      if (s.label === 'smooth') cell.smooth++;
      else if (s.label === 'rough') cell.rough++;
      else if (s.label === 'bump') cell.bump++;
    }
  });
  const features: GeoJSON.Feature<GeoJSON.Polygon, HexProps>[] = [];
  for (const c of cells.values()) {
    const denom = c.smooth + c.rough + c.bump;
    const comfort = denom
      ? Math.round(((weights.smooth * c.smooth + weights.rough * c.rough) / denom) * 100)
      : 0;
    const [cx, cy] = hexCentre(c.q, c.r, sizeM);
    const ring = hexPolygon(cx, cy, sizeM).map(([x, y]) => grid.toLonLat(x, y));
    features.push({
      type: 'Feature',
      properties: {
        count: c.count,
        smooth: c.smooth,
        rough: c.rough,
        bump: c.bump,
        comfort,
        rides: c.rideIds.size,
      },
      geometry: { type: 'Polygon', coordinates: [ring] },
    });
  }
  return { type: 'FeatureCollection', features };
}

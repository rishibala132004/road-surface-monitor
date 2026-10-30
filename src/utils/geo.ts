/**
 * Geographic maths: distances, bearings, interpolation and a small local
 * metre grid used for hex binning. All angles in degrees, distances in metres.
 */
export type LonLat = [number, number];

const R = 6371008.8;
const DEG = Math.PI / 180;

/** Great-circle distance between two [lon, lat] points in metres. */
export function haversine(a: LonLat, b: LonLat): number {
  const dLat = (b[1] - a[1]) * DEG;
  const dLon = (b[0] - a[0]) * DEG;
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(a[1] * DEG) * Math.cos(b[1] * DEG) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Initial bearing from a to b, 0..360 clockwise from north. */
export function bearing(a: LonLat, b: LonLat): number {
  const phi1 = a[1] * DEG;
  const phi2 = b[1] * DEG;
  const dLon = (b[0] - a[0]) * DEG;
  const y = Math.sin(dLon) * Math.cos(phi2);
  const x = Math.cos(phi1) * Math.sin(phi2) - Math.sin(phi1) * Math.cos(phi2) * Math.cos(dLon);
  return (((Math.atan2(y, x) / DEG) % 360) + 360) % 360;
}

/** Linear interpolation between two points (fine at street scale). */
export function lerpPoint(a: LonLat, b: LonLat, t: number): LonLat {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
}

/** Shortest signed difference between two bearings, in degrees (-180..180). */
export function bearingDelta(from: number, to: number): number {
  return ((to - from + 540) % 360) - 180;
}

/** Offset a point by east/north metres. */
export function offsetMetres(p: LonLat, east: number, north: number): LonLat {
  const dLat = north / R / DEG;
  const dLon = east / (R * Math.cos(p[1] * DEG)) / DEG;
  return [p[0] + dLon, p[1] + dLat];
}

/** Cumulative distance along a line, in metres, one entry per vertex. */
export function cumulativeDistance(line: LonLat[]): number[] {
  const out = new Array<number>(line.length);
  out[0] = 0;
  for (let i = 1; i < line.length; i++) {
    out[i] = (out[i - 1] ?? 0) + haversine(line[i - 1]!, line[i]!);
  }
  return out;
}

/** A polyline with precomputed cumulative distances for fast lookups along it. */
export class Polyline {
  readonly cum: number[];
  readonly length: number;

  constructor(readonly points: LonLat[]) {
    this.cum = cumulativeDistance(points);
    this.length = this.cum[this.cum.length - 1] ?? 0;
  }

  /** Position and heading at a distance along the line (clamped). */
  at(distance: number): { point: LonLat; heading: number; index: number } {
    const d = Math.max(0, Math.min(this.length, distance));
    let lo = 0;
    let hi = this.cum.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if ((this.cum[mid] ?? 0) <= d) lo = mid;
      else hi = mid;
    }
    const a = this.points[lo]!;
    const b = this.points[Math.min(hi, this.points.length - 1)]!;
    const segLen = (this.cum[hi] ?? 0) - (this.cum[lo] ?? 0);
    const t = segLen > 0 ? (d - (this.cum[lo] ?? 0)) / segLen : 0;
    return { point: lerpPoint(a, b, t), heading: bearing(a, b), index: lo };
  }
}

/**
 * Local equirectangular projection around an origin, in metres. Good enough
 * for a city-sized area and far cheaper than a real projection.
 */
export class LocalGrid {
  private readonly kx: number;
  private readonly ky = R * DEG;

  constructor(readonly origin: LonLat) {
    this.kx = R * DEG * Math.cos(origin[1] * DEG);
  }

  toXY(p: LonLat): [number, number] {
    return [(p[0] - this.origin[0]) * this.kx, (p[1] - this.origin[1]) * this.ky];
  }

  toLonLat(x: number, y: number): LonLat {
    return [this.origin[0] + x / this.kx, this.origin[1] + y / this.ky];
  }
}

/** Axial hex coordinates for a flat-top hex grid of the given size (metres). */
export function hexCell(x: number, y: number, size: number): [number, number] {
  const q = ((2 / 3) * x) / size;
  const r = ((-1 / 3) * x + (Math.sqrt(3) / 3) * y) / size;
  return hexRound(q, r);
}

export function hexCentre(q: number, r: number, size: number): [number, number] {
  return [size * 1.5 * q, size * (Math.sqrt(3) / 2) * q + size * Math.sqrt(3) * r];
}

export function hexPolygon(cx: number, cy: number, size: number): [number, number][] {
  const pts: [number, number][] = [];
  for (let i = 0; i < 6; i++) {
    const a = (Math.PI / 180) * (60 * i);
    pts.push([cx + size * Math.cos(a), cy + size * Math.sin(a)]);
  }
  pts.push(pts[0]!);
  return pts;
}

function hexRound(q: number, r: number): [number, number] {
  const s = -q - r;
  let rq = Math.round(q);
  let rr = Math.round(r);
  const rs = Math.round(s);
  const dq = Math.abs(rq - q);
  const dr = Math.abs(rr - r);
  const ds = Math.abs(rs - s);
  if (dq > dr && dq > ds) rq = -rr - rs;
  else if (dr > ds) rr = -rq - rs;
  return [rq, rr];
}

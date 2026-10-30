/**
 * Time join between GPS fixes and condition results.
 *
 * The phone sends positions and the Pi sends conditions, so they arrive
 * separately. For a condition at time t we look for GPS fixes within a
 * window around t: if two fixes bracket t we interpolate between them,
 * otherwise we take the nearest one. Conditions without a usable fix get
 * no position (they still feed the readouts and timeline).
 */
import type { GpsMessage } from './contract';
import { bearingDelta, lerpPoint } from '../utils/geo';

export interface JoinedPosition {
  lat: number;
  lon: number;
  /** km/h, interpolated when available. */
  speed?: number;
  heading?: number;
  acc?: number;
  alt?: number;
  /** |t_condition - t_fix| of the fix used (0 when interpolated). */
  ageMs: number;
  interpolated: boolean;
}

/** Keeps a bounded, time-sorted buffer of fixes for one device. */
export class GpsBuffer {
  private fixes: GpsMessage[] = [];

  constructor(private readonly maxFixes = 20_000) {}

  get size(): number {
    return this.fixes.length;
  }

  get latest(): GpsMessage | undefined {
    return this.fixes[this.fixes.length - 1];
  }

  all(): readonly GpsMessage[] {
    return this.fixes;
  }

  clear(): void {
    this.fixes = [];
  }

  push(fix: GpsMessage): void {
    // Fixes normally arrive in order; insert sorted when they do not.
    const last = this.fixes[this.fixes.length - 1];
    if (!last || fix.ts >= last.ts) this.fixes.push(fix);
    else {
      let i = this.fixes.length - 1;
      while (i > 0 && (this.fixes[i - 1]?.ts ?? 0) > fix.ts) i--;
      this.fixes.splice(i, 0, fix);
    }
    if (this.fixes.length > this.maxFixes) this.fixes.splice(0, this.fixes.length - this.maxFixes);
  }

  /** Index of the first fix with ts >= t (binary search). */
  private lowerBound(t: number): number {
    let lo = 0;
    let hi = this.fixes.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if ((this.fixes[mid]?.ts ?? 0) < t) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  /** Position for time t within +-windowMs, or null. */
  locate(t: number, windowMs: number): JoinedPosition | null {
    if (!this.fixes.length) return null;
    const i = this.lowerBound(t);
    const after = this.fixes[i];
    const before = this.fixes[i - 1];

    if (before && after && after.ts - before.ts > 0) {
      const span = after.ts - before.ts;
      // Interpolate only when both neighbours are within the window and the
      // gap between them is not absurd (a GPS outage should not draw a chord).
      if (t - before.ts <= windowMs && after.ts - t <= windowMs && span <= windowMs * 4) {
        const f = (t - before.ts) / span;
        const [lon, lat] = lerpPoint([before.lon, before.lat], [after.lon, after.lat], f);
        const pos: JoinedPosition = { lat, lon, ageMs: 0, interpolated: true };
        if (before.speed != null && after.speed != null)
          pos.speed = before.speed + (after.speed - before.speed) * f;
        else pos.speed = before.speed ?? after.speed;
        if (before.heading != null && after.heading != null) {
          pos.heading =
            (before.heading + bearingDelta(before.heading, after.heading) * f + 360) % 360;
        } else pos.heading = before.heading ?? after.heading;
        pos.acc = Math.max(before.acc ?? 0, after.acc ?? 0) || undefined;
        if (before.alt != null && after.alt != null)
          pos.alt = before.alt + (after.alt - before.alt) * f;
        return pos;
      }
    }

    const candidates = [before, after].filter((f): f is GpsMessage => !!f);
    let best: GpsMessage | undefined;
    let bestAge = Infinity;
    for (const c of candidates) {
      const age = Math.abs(c.ts - t);
      if (age < bestAge) {
        best = c;
        bestAge = age;
      }
    }
    if (!best || bestAge > windowMs) return null;
    return {
      lat: best.lat,
      lon: best.lon,
      speed: best.speed,
      heading: best.heading,
      acc: best.acc,
      alt: best.alt,
      ageMs: bestAge,
      interpolated: false,
    };
  }
}

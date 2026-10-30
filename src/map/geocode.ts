/**
 * Reverse geocoding with Nominatim, within its usage policy: at most one
 * request per second, results cached, an identifying contact where given,
 * and a graceful fallback (route street names or plain coordinates) when
 * the service is unreachable.
 */
import type { GeocodingConfig } from '../config/types';
import { Polyline, haversine, type LonLat } from '../utils/geo';

export interface PlaceName {
  street: string;
  area: string;
  source: 'nominatim' | 'route' | 'none';
}

interface RouteStreet {
  name: string;
  from_m: number;
  to_m: number;
}

type Resolver = (place: PlaceName) => void;

export class Geocoder {
  private cache = new Map<string, PlaceName>();
  private queue: { key: string; p: LonLat; resolvers: Resolver[] }[] = [];
  private pending = new Map<string, Resolver[]>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private lastRequest = 0;
  private failures = 0;
  private routeLine: Polyline | null = null;
  private routeStreets: RouteStreet[] = [];
  online = true;

  constructor(private cfg: GeocodingConfig) {}

  setConfig(cfg: GeocodingConfig): void {
    this.cfg = cfg;
  }

  /** Street names baked into the simulator route, used when offline. */
  setRoute(coords: LonLat[], streets: RouteStreet[]): void {
    this.routeLine = new Polyline(coords);
    this.routeStreets = streets;
  }

  /** Cache key: a grid of roughly 40 m, so neighbouring samples share a lookup. */
  static key(p: LonLat): string {
    return `${Math.round(p[1] * 2500)}:${Math.round(p[0] * 1500)}`;
  }

  /** Synchronous best effort: cached result or route fallback. */
  lookupSync(p: LonLat): PlaceName {
    const cached = this.cache.get(Geocoder.key(p));
    if (cached) return cached;
    return this.fromRoute(p) ?? { street: '', area: '', source: 'none' };
  }

  /** Resolves with a cached value immediately or queues a request. */
  lookup(p: LonLat): Promise<PlaceName> {
    const key = Geocoder.key(p);
    const cached = this.cache.get(key);
    if (cached) return Promise.resolve(cached);
    if (!this.cfg.enabled || !this.online) return Promise.resolve(this.lookupSync(p));
    return new Promise((resolve) => {
      const waiting = this.pending.get(key);
      if (waiting) {
        waiting.push(resolve);
        return;
      }
      this.pending.set(key, [resolve]);
      this.queue.push({ key, p, resolvers: this.pending.get(key)! });
      this.schedule();
    });
  }

  /** Puts a point at the front of the queue (the live position matters most). */
  prioritise(p: LonLat): void {
    const key = Geocoder.key(p);
    const i = this.queue.findIndex((q) => q.key === key);
    if (i > 0) this.queue.unshift(...this.queue.splice(i, 1));
  }

  private schedule(): void {
    if (this.timer || !this.queue.length) return;
    const wait = Math.max(0, this.cfg.minIntervalMs - (Date.now() - this.lastRequest));
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.next();
    }, wait);
  }

  private async next(): Promise<void> {
    const item = this.queue.shift();
    if (!item) return;
    this.lastRequest = Date.now();
    let place: PlaceName | null = null;
    try {
      const url = new URL(this.cfg.url);
      url.searchParams.set('format', 'jsonv2');
      url.searchParams.set('lat', item.p[1].toFixed(6));
      url.searchParams.set('lon', item.p[0].toFixed(6));
      url.searchParams.set('zoom', '17');
      url.searchParams.set('addressdetails', '1');
      if (this.cfg.contact) url.searchParams.set('email', this.cfg.contact);
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 6000);
      // Browsers forbid a custom User-Agent; the Referer header identifies the site instead.
      const res = await fetch(url.toString(), {
        signal: ctrl.signal,
        referrerPolicy: 'origin',
        headers: { Accept: 'application/json' },
      });
      clearTimeout(t);
      if (res.ok) {
        const json = (await res.json()) as { address?: Record<string, string> };
        const a = json.address ?? {};
        const street =
          a.road ??
          a.pedestrian ??
          a.footway ??
          a.cycleway ??
          a.path ??
          a.square ??
          a.neighbourhood ??
          '';
        const area =
          a.neighbourhood ??
          a.suburb ??
          a.quarter ??
          a.city_district ??
          a.village ??
          a.town ??
          a.city ??
          '';
        place = { street, area: area === street ? '' : area, source: 'nominatim' };
        this.failures = 0;
        this.online = true;
      } else if (res.status === 429 || res.status === 403) {
        this.failures += 3;
      } else this.failures++;
    } catch {
      this.failures++;
    }
    if (!place) {
      // After a few failures, stop hammering the network until the next lookup after a pause.
      if (this.failures >= 3) {
        this.online = false;
        setTimeout(() => {
          this.online = true;
          this.failures = 0;
        }, 60_000);
        for (const q of this.queue)
          this.settle(q.key, this.fromRoute(q.p) ?? { street: '', area: '', source: 'none' });
        this.queue = [];
      }
      place = this.fromRoute(item.p) ?? { street: '', area: '', source: 'none' };
    } else {
      this.cache.set(item.key, place);
    }
    this.settle(item.key, place);
    this.schedule();
  }

  private settle(key: string, place: PlaceName): void {
    const resolvers = this.pending.get(key) ?? [];
    this.pending.delete(key);
    for (const r of resolvers) r(place);
  }

  /** Nearest street along the shipped route, if the point is within 40 m of it. */
  private fromRoute(p: LonLat): PlaceName | null {
    if (!this.routeLine) return null;
    let best = Infinity;
    let bestDist = 0;
    const pts = this.routeLine.points;
    for (let i = 0; i < pts.length; i++) {
      const d = haversine(p, pts[i]!);
      if (d < best) {
        best = d;
        bestDist = this.routeLine.cum[i] ?? 0;
      }
    }
    if (best > 40) return null;
    const street = this.routeStreets.find((s) => bestDist >= s.from_m && bestDist <= s.to_m);
    return street ? { street: street.name, area: 'Enschede', source: 'route' } : null;
  }
}

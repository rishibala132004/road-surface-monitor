/**
 * Number, unit and coordinate formatting. British spelling, metric units.
 */
import type { CoordFormat, SpeedUnit } from '../config/types';

export function formatSpeed(kmh: number | null | undefined, unit: SpeedUnit): string {
  if (kmh == null || !Number.isFinite(kmh)) return '--';
  return unit === 'ms' ? (kmh / 3.6).toFixed(1) : kmh.toFixed(1);
}

export function speedUnitLabel(unit: SpeedUnit): string {
  return unit === 'ms' ? 'm/s' : 'km/h';
}

export function formatDistance(metres: number): string {
  if (!Number.isFinite(metres)) return '--';
  return metres >= 1000 ? `${(metres / 1000).toFixed(2)} km` : `${Math.round(metres)} m`;
}

export function formatPercent(fraction: number): string {
  return `${Math.round(fraction * 100)}%`;
}

export function formatFixed(v: number | null | undefined, digits = 1): string {
  return v == null || !Number.isFinite(v) ? '--' : v.toFixed(digits);
}

/** Decimal degrees, 5 places (about 1 m). */
export function formatDD(lat: number, lon: number): string {
  return `${lat.toFixed(5)}, ${lon.toFixed(5)}`;
}

function toDMS(value: number, pos: string, neg: string): string {
  const hemi = value >= 0 ? pos : neg;
  const abs = Math.abs(value);
  const d = Math.floor(abs);
  const mFloat = (abs - d) * 60;
  const m = Math.floor(mFloat);
  const s = (mFloat - m) * 60;
  return `${d}°${String(m).padStart(2, '0')}′${s.toFixed(1).padStart(4, '0')}″ ${hemi}`;
}

export function formatDMS(lat: number, lon: number): string {
  return `${toDMS(lat, 'N', 'S')}  ${toDMS(lon, 'E', 'W')}`;
}

export function formatCoords(lat: number, lon: number, fmt: CoordFormat): string {
  return fmt === 'dms' ? formatDMS(lat, lon) : formatDD(lat, lon);
}

/** Seconds -> mm:ss (or h:mm:ss above an hour). */
export function formatClock(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const mm = String(m).padStart(2, '0');
  const ss = String(sec).padStart(2, '0');
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

/** Wall clock HH:MM:SS from a ms timestamp. */
export function formatTime(ts: number): string {
  const d = new Date(ts);
  return [d.getHours(), d.getMinutes(), d.getSeconds()]
    .map((n) => String(n).padStart(2, '0'))
    .join(':');
}

export function formatAge(ms: number): string {
  if (!Number.isFinite(ms)) return '--';
  if (ms < 1000) return 'now';
  if (ms < 60_000) return `${Math.floor(ms / 1000)} s`;
  return `${Math.floor(ms / 60_000)} min`;
}

export function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

export function round(v: number, digits: number): number {
  const f = 10 ** digits;
  return Math.round(v * f) / f;
}

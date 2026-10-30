/**
 * Time helpers. Timestamps are milliseconds since the epoch throughout the app.
 */

/** Accepts seconds or milliseconds and returns milliseconds. */
export function normaliseTimestamp(v: unknown, fallback: number): number {
  const n = typeof v === 'string' ? Number(v) : v;
  if (typeof n !== 'number' || !Number.isFinite(n) || n <= 0) return fallback;
  // Anything below 1e11 cannot be a sensible ms timestamp (that is 1973).
  return n < 1e11 ? Math.round(n * 1000) : Math.round(n);
}

export function now(): number {
  return Date.now();
}

/** Monotonic ms clock for animations. */
export function perfNow(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

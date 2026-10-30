import { describe, expect, it } from 'vitest';
import { GpsBuffer } from '../src/data/join';
import type { GpsMessage } from '../src/data/contract';

function fix(ts: number, lat: number, lon: number, extra: Partial<GpsMessage> = {}): GpsMessage {
  return { kind: 'gps', device: 'bike1', ts, lat, lon, receivedAt: ts, ...extra };
}

describe('GpsBuffer.locate', () => {
  it('interpolates between bracketing fixes', () => {
    const b = new GpsBuffer();
    b.push(fix(1000, 52.0, 6.0, { speed: 10, heading: 350 }));
    b.push(fix(3000, 52.002, 6.002, { speed: 20, heading: 10 }));
    const p = b.locate(2000, 3000);
    expect(p).not.toBeNull();
    expect(p!.lat).toBeCloseTo(52.001, 6);
    expect(p!.lon).toBeCloseTo(6.001, 6);
    expect(p!.speed).toBeCloseTo(15);
    expect(p!.heading).toBeCloseTo(0, 5); // 350 -> 10 goes through north
    expect(p!.interpolated).toBe(true);
    expect(p!.ageMs).toBe(0);
  });

  it('takes the nearest fix when only one side is available', () => {
    const b = new GpsBuffer();
    b.push(fix(1000, 52.0, 6.0));
    const p = b.locate(2500, 3000);
    expect(p).toMatchObject({ lat: 52.0, lon: 6.0, interpolated: false, ageMs: 1500 });
  });

  it('returns null outside the window', () => {
    const b = new GpsBuffer();
    b.push(fix(1000, 52.0, 6.0));
    expect(b.locate(10_000, 3000)).toBeNull();
  });

  it('does not draw a chord across a long GPS gap', () => {
    const b = new GpsBuffer();
    b.push(fix(0, 52.0, 6.0));
    b.push(fix(60_000, 52.01, 6.01));
    // Both neighbours are far away: nearest is beyond the window -> null.
    expect(b.locate(30_000, 3000)).toBeNull();
    // Close to one end it takes the nearest fix instead of interpolating.
    expect(b.locate(1000, 3000)).toMatchObject({ lat: 52.0, interpolated: false });
  });

  it('keeps fixes sorted when they arrive out of order', () => {
    const b = new GpsBuffer();
    b.push(fix(3000, 52.003, 6));
    b.push(fix(1000, 52.001, 6));
    b.push(fix(2000, 52.002, 6));
    expect(b.all().map((f) => f.ts)).toEqual([1000, 2000, 3000]);
  });
});

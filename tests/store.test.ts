import { describe, expect, it } from 'vitest';
import { RideStore } from '../src/data/store';
import { BUILTIN_CONFIG } from '../src/config/defaults';
import { parseMessage, type ParseContext } from '../src/data/contract';

const ctx: ParseContext = {
  topicPrefix: 'road',
  classIds: ['smooth', 'rough', 'bump', 'stopped'],
  aliases: {},
  owntracksMap: {},
  owntracksDefaultBike: 'bike1',
};

function feed(
  store: RideStore,
  topic: string,
  payload: Record<string, unknown>,
  receivedAt: number,
): void {
  const msg = parseMessage(topic, JSON.stringify(payload), { ...ctx, receivedAt });
  if (msg) store.ingest(msg, { topic, payload: JSON.stringify(payload) });
}

/** A straight ride north at 5 m/s: one fix and one condition per second. */
function ride(store: RideStore, labels: string[], withSeq = true): void {
  const t0 = 1_793_290_000_000;
  labels.forEach((label, i) => {
    const ts = t0 + i * 1000;
    feed(store, 'road/bike1/gps', { lat: 52 + i * 0.000045, lon: 6.87, ts, speed: 18 }, ts + 50);
    feed(
      store,
      'road/bike1/condition',
      { label, confidence: 0.9, ts, seq: withSeq ? i : undefined },
      ts + 120,
    );
  });
}

describe('RideStore', () => {
  it('creates devices on first message and selects the first one', () => {
    const store = new RideStore(BUILTIN_CONFIG);
    feed(store, 'road/bike1/condition', { label: 'smooth', ts: 1 }, 1);
    feed(store, 'road/bike2/condition', { label: 'rough', ts: 1 }, 1);
    expect([...store.devices.keys()]).toEqual(['bike1', 'bike2']);
    expect(store.selectedId).toBe('bike1');
    expect(store.devices.get('bike2')?.slot).toBe(2);
  });

  it('joins conditions to GPS and accumulates distance', () => {
    const store = new RideStore(BUILTIN_CONFIG);
    ride(store, ['smooth', 'smooth', 'smooth', 'smooth', 'smooth']);
    const d = store.devices.get('bike1')!;
    expect(d.samples.every((s) => s.pos)).toBe(true);
    // 4 steps of ~5 m
    expect(d.stats.distanceM).toBeGreaterThan(18);
    expect(d.stats.distanceM).toBeLessThan(22);
    expect(d.stats.avgSpeed).toBeGreaterThan(10);
  });

  it('attaches a late GPS fix to an earlier condition', () => {
    const store = new RideStore(BUILTIN_CONFIG);
    const ts = 1_793_290_000_000;
    feed(store, 'road/bike1/condition', { label: 'rough', ts }, ts + 100);
    expect(store.devices.get('bike1')!.samples[0]!.pos).toBeNull();
    feed(store, 'road/bike1/gps', { lat: 52.1, lon: 6.8, ts: ts + 800 }, ts + 900);
    expect(store.devices.get('bike1')!.samples[0]!.pos).toMatchObject({ lat: 52.1, lon: 6.8 });
  });

  it('leaves a condition unpositioned when no fix is within the window', () => {
    const store = new RideStore(BUILTIN_CONFIG);
    const ts = 1_793_290_000_000;
    feed(store, 'road/bike1/gps', { lat: 52.1, lon: 6.8, ts: ts - 10_000 }, ts - 10_000);
    feed(store, 'road/bike1/condition', { label: 'rough', ts }, ts);
    expect(store.devices.get('bike1')!.samples[0]!.pos).toBeNull();
    expect(store.devices.get('bike1')!.stats.received).toBe(1);
  });

  it('counts bumps, merges consecutive bump windows and counts stops', () => {
    const store = new RideStore(BUILTIN_CONFIG);
    ride(store, [
      'smooth',
      'bump',
      'bump',
      'smooth',
      'stopped',
      'stopped',
      'stopped',
      'stopped',
      'smooth',
      'bump',
    ]);
    const st = store.devices.get('bike1')!.stats;
    expect(st.bumps).toBe(2);
    expect(st.stops).toBe(1);
  });

  it('detects lost messages from seq gaps', () => {
    const store = new RideStore(BUILTIN_CONFIG);
    const ts = 1_793_290_000_000;
    feed(store, 'road/bike1/condition', { label: 'smooth', ts, seq: 10 }, ts);
    feed(store, 'road/bike1/condition', { label: 'smooth', ts: ts + 1000, seq: 11 }, ts + 1000);
    feed(store, 'road/bike1/condition', { label: 'smooth', ts: ts + 4000, seq: 14 }, ts + 4000);
    expect(store.devices.get('bike1')!.stats.lost).toBe(2);
  });

  it('computes the comfort score with the documented formula', () => {
    const store = new RideStore(BUILTIN_CONFIG);
    // 6 smooth, 2 rough, 0 bump, 2 stopped -> base = (6 + 0.5*2)/8*100 = 87.5
    ride(store, [
      'smooth',
      'smooth',
      'smooth',
      'rough',
      'rough',
      'stopped',
      'stopped',
      'smooth',
      'smooth',
      'smooth',
    ]);
    const st = store.devices.get('bike1')!.stats;
    expect(st.comfort).toBeCloseTo(87.5, 1);
  });

  it('sampleAt returns the last sample at or before a time', () => {
    const store = new RideStore(BUILTIN_CONFIG);
    ride(store, ['smooth', 'rough', 'bump']);
    const d = store.devices.get('bike1')!;
    const t0 = 1_793_290_000_000;
    expect(store.sampleAt(d, t0 + 1500)?.label).toBe('rough');
    expect(store.sampleAt(d, t0 - 1)).toBeNull();
    expect(store.sampleAt(d, null)?.label).toBe('bump');
  });

  it('reset clears everything', () => {
    const store = new RideStore(BUILTIN_CONFIG);
    ride(store, ['smooth']);
    store.reset();
    expect(store.devices.size).toBe(0);
    expect(store.records.length).toBe(0);
    expect(store.selectedId).toBeNull();
  });
});

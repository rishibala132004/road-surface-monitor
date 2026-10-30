import { describe, expect, it } from 'vitest';
import { RideStore } from '../src/data/store';
import { BUILTIN_CONFIG } from '../src/config/defaults';
import { parseMessage } from '../src/data/contract';
import { groupByStreet, segmentRide } from '../src/map/segments';
import { buildHexGrid, buildRuns } from '../src/map/layers';

function ride(labels: string[]): RideStore {
  const store = new RideStore(BUILTIN_CONFIG);
  const t0 = 1_793_290_000_000;
  labels.forEach((label, i) => {
    const ts = t0 + i * 1000;
    const ctx = {
      topicPrefix: 'road',
      classIds: ['smooth', 'rough', 'bump', 'stopped'],
      aliases: {},
      owntracksMap: {},
      owntracksDefaultBike: 'bike1',
      receivedAt: ts,
    };
    // 5 m per second northwards
    store.ingest(
      parseMessage(
        'road/bike1/gps',
        JSON.stringify({ lat: 52 + i * 0.000045, lon: 6.87, ts, speed: 18 }),
        ctx,
      )!,
    );
    store.ingest(
      parseMessage('road/bike1/condition', JSON.stringify({ label, confidence: 0.9, ts }), ctx)!,
    );
  });
  return store;
}

describe('segments and streets', () => {
  it('cuts the ride into segments of about the requested length', () => {
    const store = ride(new Array(40).fill('smooth'));
    const segments = segmentRide(store.devices.get('bike1')!, 25);
    expect(segments.length).toBeGreaterThanOrEqual(5);
    expect(segments.length).toBeLessThanOrEqual(9);
    for (const s of segments.slice(0, -1)) expect(s.metres).toBeLessThanOrEqual(25 * 1.5 + 0.01);
  });

  it('groups by street, worst first, with a comfort score and a strip', () => {
    const store = ride([
      ...new Array(12).fill('smooth'),
      ...new Array(12).fill('rough'),
      'bump',
      ...new Array(6).fill('smooth'),
    ]);
    const segments = segmentRide(store.devices.get('bike1')!, 25);
    segments.forEach((s, i) => (s.street = i < 3 ? 'Campus' : 'Cobbles'));
    const reports = groupByStreet(segments, BUILTIN_CONFIG.comfort, [
      'smooth',
      'rough',
      'bump',
      'stopped',
    ]);
    expect(reports[0]!.name).toBe('Cobbles');
    expect(reports[0]!.comfort).toBeLessThan(reports[1]!.comfort);
    expect(reports[0]!.strip.length).toBe(reports[0]!.segments.length);
  });
});

describe('map layers', () => {
  it('builds one run per change of label and keeps runs connected', () => {
    const store = ride(['smooth', 'smooth', 'rough', 'rough', 'smooth']);
    const runs = buildRuns(store.devices.get('bike1')!);
    expect(runs.map((r) => r.properties.label)).toEqual(['smooth', 'rough', 'smooth']);
    const first = runs[0]!.geometry.coordinates;
    const second = runs[1]!.geometry.coordinates;
    expect(second[0]).toEqual(first[first.length - 1]);
  });

  it('aggregates samples into hex cells with a comfort value', () => {
    const store = ride(new Array(30).fill('rough'));
    const fc = buildHexGrid([store.devices.get('bike1')!.samples], 28);
    expect(fc.features.length).toBeGreaterThan(2);
    for (const f of fc.features) expect(f.properties.comfort).toBe(50);
  });
});

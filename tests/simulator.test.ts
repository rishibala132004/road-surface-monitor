import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { SimulatedRide } from '../src/data/sources/SimulatedSource';
import { parseMessage } from '../src/data/contract';
import { RideStore } from '../src/data/store';
import { BUILTIN_CONFIG } from '../src/config/defaults';
import type { LonLat } from '../src/utils/geo';

const route = (
  JSON.parse(readFileSync('public/sim/route.geojson', 'utf8')) as {
    features: { geometry: { coordinates: LonLat[] } }[];
  }
).features[0]!.geometry.coordinates;

const opts = {
  topicPrefix: 'road',
  classIds: ['smooth', 'rough', 'bump', 'stopped'],
  speed: 1,
  prefillS: 0,
  secondBike: false,
  errorRate: 0.04,
  bikeIds: ['bike1', 'bike2'],
  seed: 7,
};

describe('route', () => {
  it('is 4 to 5 km long and follows streets in Enschede', () => {
    const ride = new SimulatedRide(route, opts, 0);
    expect(ride.line.length).toBeGreaterThan(3900);
    expect(ride.line.length).toBeLessThan(5100);
    for (const [lon, lat] of route) {
      expect(lon).toBeGreaterThan(6.8);
      expect(lon).toBeLessThan(6.95);
      expect(lat).toBeGreaterThan(52.2);
      expect(lat).toBeLessThan(52.26);
    }
  });
});

describe('SimulatedRide', () => {
  it('emits one gps and about one condition per second in contract format', () => {
    const ride = new SimulatedRide(route, opts, 1_793_290_000_000);
    let gps = 0;
    let cond = 0;
    for (let i = 0; i < 300; i++) {
      for (const m of ride.step()) {
        const msg = parseMessage(m.topic, JSON.stringify(m.payload), {
          topicPrefix: 'road',
          classIds: opts.classIds,
          aliases: {},
          owntracksMap: {},
          owntracksDefaultBike: 'bike1',
          receivedAt: ride.simTime,
        });
        expect(msg).not.toBeNull();
        if (msg?.kind === 'gps') gps++;
        if (msg?.kind === 'condition') {
          cond++;
          expect(msg.known).toBe(true);
          expect(msg.scores).toBeDefined();
          expect(msg.vib).toBeGreaterThan(0);
          expect(msg.inferenceMs).toBeGreaterThan(0);
          expect(msg.seq).toBeDefined();
        }
      }
    }
    expect(gps).toBe(300);
    expect(cond).toBeGreaterThan(285); // about 1% loss
  });

  it('produces the whole ride profile over one pass of the route', () => {
    const ride = new SimulatedRide(route, opts, 1_793_290_000_000);
    const store = new RideStore(BUILTIN_CONFIG);
    const labels = new Set<string>();
    let lowConf = 0;
    let total = 0;
    let maxSpeed = 0;
    // 4 km at ~16 km/h plus stops is about 1000 s; stop when the bike turns round.
    for (let i = 0; i < 1400; i++) {
      for (const m of ride.step()) {
        const msg = parseMessage(m.topic, JSON.stringify(m.payload), {
          topicPrefix: 'road',
          classIds: opts.classIds,
          aliases: {},
          owntracksMap: {},
          owntracksDefaultBike: 'bike1',
          receivedAt: ride.simTime,
        });
        if (!msg) continue;
        store.ingest(msg);
        if (msg.kind === 'condition') {
          labels.add(msg.label);
          total++;
          if (msg.confidence < 0.6) lowConf++;
        }
        if (msg.kind === 'gps') maxSpeed = Math.max(maxSpeed, msg.speed ?? 0);
      }
      if (ride.bikes[0]!.direction === -1) break;
    }
    const st = store.devices.get('bike1')!.stats;
    expect([...labels].sort()).toEqual(['bump', 'rough', 'smooth', 'stopped']);
    expect(st.bumps).toBeGreaterThanOrEqual(5);
    expect(st.bumps).toBeLessThanOrEqual(10); // 8 real plus the odd false positive
    expect(st.stops).toBeGreaterThanOrEqual(3);
    expect(st.roughM).toBeGreaterThan(300);
    expect(st.distanceM).toBeGreaterThan(3600);
    expect(maxSpeed).toBeLessThan(21);
    expect(lowConf / total).toBeGreaterThan(0.015);
    expect(lowConf / total).toBeLessThan(0.09);
  });

  it('second bike rides the route in reverse', () => {
    const ride = new SimulatedRide(route, { ...opts, secondBike: true }, 0);
    expect(ride.bikes.length).toBe(2);
    expect(ride.bikes[1]!.direction).toBe(-1);
    const msgs = ride.step();
    expect(msgs.some((m) => m.topic === 'road/bike2/gps')).toBe(true);
  });
});

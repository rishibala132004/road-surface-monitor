/**
 * Simulated ride along a real route (public/sim/route.geojson).
 *
 * Generates messages in exactly the contract format, one condition and
 * one GPS fix per simulated second per bike, plus a status message every
 * ten seconds. The ride profile is deterministic in its structure (where
 * the rough sections, bumps and traffic lights are) and random in its
 * detail (speed, GPS noise, model mistakes), so every run looks alive but
 * every feature of the dashboard is guaranteed to show up.
 *
 * The same code also runs headless in tools/make-demo-ride.mjs through
 * `SimulatedRide`, which is why it has no DOM dependencies.
 */
import { BaseSource } from './DataSource';
import { Polyline, offsetMetres, type LonLat } from '../../utils/geo';

export interface SimOptions {
  topicPrefix: string;
  classIds: string[];
  /** Playback multiplier (1, 4, 10). */
  speed: number;
  /** Seconds generated instantly at start. */
  prefillS: number;
  secondBike: boolean;
  errorRate: number;
  bikeIds: string[];
  /** Seed for the random generator. */
  seed?: number;
}

interface RoughSection {
  from: number;
  to: number;
}

interface RideProfile {
  rough: RoughSection[];
  bumps: number[];
  stops: { at: number; seconds: number }[];
}

/** Small deterministic PRNG (mulberry32) so tests and the demo log are repeatable. */
export function makeRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Builds the ride profile as fractions of the route length. */
export function defaultProfile(length: number): RideProfile {
  const f = (x: number) => Math.round(length * x);
  return {
    // Campus gravel path, a patched stretch of Hengelosestraat, cobbles in the centre.
    rough: [
      { from: f(0.14), to: f(0.19) },
      { from: f(0.47), to: f(0.52) },
      { from: f(0.69), to: f(0.715) },
      { from: f(0.905), to: length },
    ],
    // Some in pairs (speed bumps have two edges).
    bumps: [f(0.08), f(0.255), f(0.262), f(0.38), f(0.58), f(0.587), f(0.76), f(0.86)],
    stops: [
      { at: f(0.31), seconds: 11 },
      { at: f(0.63), seconds: 14 },
      { at: f(0.81), seconds: 9 },
    ],
  };
}

interface BikeState {
  id: string;
  direction: 1 | -1;
  /** Position along the route, metres from the route start. */
  d: number;
  /** m/s */
  v: number;
  targetV: number;
  stopLeft: number;
  stopsDone: Set<number>;
  bumpsDone: Set<number>;
  bumpActive: number;
  seq: number;
  battery: number;
  uptime: number;
  noise: [number, number];
  turnaroundLeft: number;
  distanceTotal: number;
  tempo: number;
}

const KMH = 1 / 3.6;

/** Pure ride generator: call `step()` once per simulated second. */
export class SimulatedRide {
  readonly line: Polyline;
  readonly profile: RideProfile;
  bikes: BikeState[] = [];
  simTime: number;
  private rnd: () => number;

  constructor(
    route: LonLat[],
    private readonly opts: SimOptions,
    startTime: number,
  ) {
    this.line = new Polyline(route);
    this.profile = defaultProfile(this.line.length);
    this.rnd = makeRandom(opts.seed ?? 20261106);
    this.simTime = startTime;
    this.bikes.push(this.newBike(opts.bikeIds[0] ?? 'bike1', 1, 0));
    if (opts.secondBike)
      this.bikes.push(this.newBike(opts.bikeIds[1] ?? 'bike2', -1, this.line.length));
  }

  setSecondBike(on: boolean): void {
    const has = this.bikes.length > 1;
    if (on && !has)
      this.bikes.push(this.newBike(this.opts.bikeIds[1] ?? 'bike2', -1, this.line.length));
    if (!on && has) this.bikes.splice(1);
  }

  private newBike(id: string, direction: 1 | -1, d: number): BikeState {
    return {
      id,
      direction,
      d,
      v: 0,
      targetV: 16 * KMH,
      stopLeft: 0,
      stopsDone: new Set(),
      bumpsDone: new Set(),
      bumpActive: 0,
      seq: Math.floor(this.rnd() * 1000),
      battery: 72 + Math.floor(this.rnd() * 20),
      uptime: Math.floor(this.rnd() * 900),
      noise: [0, 0],
      turnaroundLeft: 0,
      distanceTotal: 0,
      tempo: 0.9 + this.rnd() * 0.2,
    };
  }

  private uniform(a: number, b: number): number {
    return a + this.rnd() * (b - a);
  }

  private inRough(d: number): boolean {
    return this.profile.rough.some((s) => d >= s.from && d <= s.to);
  }

  /** Advances every bike by one second and returns the messages to send. */
  step(): { topic: string; payload: Record<string, unknown> }[] {
    this.simTime += 1000;
    const out: { topic: string; payload: Record<string, unknown> }[] = [];
    for (const b of this.bikes) out.push(...this.stepBike(b));
    return out;
  }

  private stepBike(b: BikeState): { topic: string; payload: Record<string, unknown> }[] {
    const p = this.opts.topicPrefix;
    const msgs: { topic: string; payload: Record<string, unknown> }[] = [];
    const rough = this.inRough(b.d);
    b.uptime += 1;

    // ---- speed control: traffic lights, turnaround at the route ends, surface.
    const ahead = (x: number) => (x - b.d) * b.direction;
    let brakingFor: { at: number; seconds: number } | null = null;
    for (const s of this.profile.stops) {
      const dist = ahead(s.at);
      if (!b.stopsDone.has(s.at) && dist >= -3 && dist < 40) brakingFor = s;
    }
    const endDist = b.direction === 1 ? this.line.length - b.d : b.d;

    if (b.stopLeft > 0) {
      b.stopLeft -= 1;
      b.v = 0;
      if (b.stopLeft === 0 && brakingFor) b.stopsDone.add(brakingFor.at);
    } else if (b.turnaroundLeft > 0) {
      b.turnaroundLeft -= 1;
      b.v = 0;
      if (b.turnaroundLeft === 0) {
        b.direction = b.direction === 1 ? -1 : 1;
        b.stopsDone.clear();
        b.bumpsDone.clear();
      }
    } else {
      // Base target speed: 15 to 19 km/h on smooth road, 11 to 14 on rough.
      const base = rough ? this.uniform(11, 14) : this.uniform(15, 19);
      b.targetV = 0.85 * b.targetV + 0.15 * base * KMH * b.tempo;
      let target = b.targetV;
      if (brakingFor) {
        const dist = Math.max(0, ahead(brakingFor.at));
        // v^2 = 2 a d with a = 1.4 m/s^2 gives a comfortable stop.
        target = Math.min(target, Math.sqrt(2 * 1.4 * dist));
        if (dist < 1.5 && b.v < 1.2) {
          b.stopLeft = brakingFor.seconds;
          b.v = 0;
        }
      }
      if (endDist < 30) {
        target = Math.min(target, Math.sqrt(2 * 1.4 * Math.max(0, endDist - 1)));
        if (endDist < 1.5) {
          b.turnaroundLeft = 18;
          b.v = 0;
        }
      }
      const accel = target > b.v ? 0.8 : -1.6;
      b.v = Math.max(0, b.v + Math.max(-1.6, Math.min(0.8, (target - b.v) * 0.9 + accel * 0.1)));
      if (target === 0 && b.v < 0.3) b.v = 0;
    }

    // ---- move along the route.
    const moved = b.v;
    b.d = Math.max(0, Math.min(this.line.length, b.d + moved * b.direction));
    b.distanceTotal += moved;

    // ---- which bumps are crossed in this second?
    let bumpNow = false;
    for (const at of this.profile.bumps) {
      if (b.bumpsDone.has(at)) continue;
      const before = b.d - moved * b.direction;
      const crossed = b.direction === 1 ? before < at && b.d >= at : before > at && b.d <= at;
      if (crossed && b.v > 1) {
        bumpNow = true;
        b.bumpsDone.add(at);
      }
    }

    // ---- ground truth label.
    const stopped = b.v < 0.6;
    const truth = stopped ? 'stopped' : bumpNow ? 'bump' : rough ? 'rough' : 'smooth';

    // ---- model output with realistic confidence and occasional mistakes.
    const ids = this.opts.classIds.length
      ? this.opts.classIds
      : ['smooth', 'rough', 'bump', 'stopped'];
    let label = truth;
    let conf: number;
    const mistake = this.rnd() < this.opts.errorRate;
    if (mistake) {
      const confusion: Record<string, string[]> = {
        smooth: ['rough', 'stopped'],
        rough: ['smooth', 'smooth', 'smooth', 'bump'],
        bump: ['rough'],
        stopped: ['smooth'],
      };
      const alts = (confusion[truth] ?? ids).filter((x) => x !== truth);
      label = alts[Math.floor(this.rnd() * alts.length)] ?? truth;
      conf = this.uniform(0.34, 0.58);
    } else {
      conf =
        truth === 'rough'
          ? this.uniform(0.7, 0.93)
          : truth === 'bump'
            ? this.uniform(0.66, 0.95)
            : this.uniform(0.82, 0.99);
    }
    const scores: Record<string, number> = {};
    let rest = 1 - conf;
    const others = ids.filter((x) => x !== label);
    others.forEach((id, i) => {
      // The true class takes most of the remainder when the model is wrong.
      const bias = id === truth && mistake ? 0.7 : 1 / (others.length + 1);
      const share =
        i === others.length - 1 ? rest : Math.min(rest, rest * bias * this.uniform(0.6, 1.2));
      scores[id] = Math.max(0, share);
      rest -= scores[id]!;
    });
    scores[label] = conf;
    const total = Object.values(scores).reduce((a, x) => a + x, 0);
    for (const k of Object.keys(scores)) scores[k] = Math.round((scores[k]! / total) * 1000) / 1000;

    const vibBase: Record<string, [number, number]> = {
      smooth: [0.5, 1.4],
      rough: [2.4, 4.6],
      bump: [6.8, 10.5],
      stopped: [0.05, 0.2],
    };
    const [lo, hi] = vibBase[truth] ?? [0.5, 1.4];
    const vib = this.uniform(lo, hi) * (truth === 'smooth' ? 0.6 + 0.4 * (b.v / 5) : 1);

    // ---- GPS fix with 3 to 6 m of slowly drifting noise.
    b.noise = [
      b.noise[0] * 0.8 + this.uniform(-2.2, 2.2),
      b.noise[1] * 0.8 + this.uniform(-2.2, 2.2),
    ];
    const { point, heading } = this.line.at(b.d);
    const pos = offsetMetres(point, b.noise[0], b.noise[1]);
    const trueHeading = b.direction === 1 ? heading : (heading + 180) % 360;
    const ts = this.simTime;

    msgs.push({
      topic: `${p}/${b.id}/gps`,
      payload: {
        lat: round(pos[1], 6),
        lon: round(pos[0], 6),
        ts,
        speed: round(b.v / KMH, 1),
        acc: round(this.uniform(3, 6), 1),
        heading: Math.round(
          stopped ? trueHeading : (trueHeading + this.uniform(-4, 4) + 360) % 360,
        ),
      },
    });

    b.seq += 1;
    // About 1% of condition messages are lost on the way, so the lost counter moves.
    if (this.rnd() >= 0.01) {
      msgs.push({
        topic: `${p}/${b.id}/condition`,
        payload: {
          v: 1,
          device: b.id,
          label,
          confidence: round(conf, 3),
          ts,
          scores,
          vib: round(vib, 2),
          inference_ms: round(this.uniform(3.4, 6.1), 1),
          seq: b.seq,
        },
      });
    }

    if (b.uptime % 10 === 0) {
      if (b.uptime % 300 === 0) b.battery = Math.max(5, b.battery - 1);
      msgs.push({
        topic: `${p}/${b.id}/status`,
        payload: {
          device: b.id,
          battery: b.battery,
          model: 'road-v3',
          rate_hz: 1,
          uptime_s: b.uptime,
          ts,
        },
      });
    }
    return msgs;
  }
}

function round(v: number, digits: number): number {
  const f = 10 ** digits;
  return Math.round(v * f) / f;
}

/** Browser data source wrapping SimulatedRide with a timer. */
export class SimulatedSource extends BaseSource {
  readonly kind = 'simulated' as const;
  private ride: SimulatedRide | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private route: LonLat[] | null = null;
  private paused = false;
  private nextTick = 0;

  constructor(
    private readonly routeUrl: string,
    private opts: SimOptions,
  ) {
    super();
  }

  get speed(): number {
    return this.opts.speed;
  }

  get isPaused(): boolean {
    return this.paused;
  }

  get secondBike(): boolean {
    return this.opts.secondBike;
  }

  async start(): Promise<void> {
    this.setStatus('starting');
    if (!this.route) this.route = await this.loadRoute();
    this.beginRide();
    this.setStatus('running');
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.setStatus('idle');
  }

  /** Starts the ride again from the campus, with the prefill. */
  restart(): void {
    if (!this.route) return;
    this.beginRide();
  }

  setSpeed(speed: number): void {
    this.opts.speed = speed;
  }

  setPaused(paused: boolean): void {
    this.paused = paused;
    this.setStatus(paused ? 'paused' : 'running');
    if (!paused) this.nextTick = performance.now();
  }

  setSecondBike(on: boolean): void {
    this.opts.secondBike = on;
    this.ride?.setSecondBike(on);
  }

  updateOptions(opts: Partial<SimOptions>): void {
    Object.assign(this.opts, opts);
  }

  private async loadRoute(): Promise<LonLat[]> {
    const res = await fetch(this.routeUrl);
    if (!res.ok) throw new Error(`Route not found: ${this.routeUrl}`);
    const gj = (await res.json()) as { features?: { geometry?: { coordinates?: LonLat[] } }[] };
    const coords = gj.features?.[0]?.geometry?.coordinates;
    if (!coords || coords.length < 2) throw new Error('Route GeoJSON has no LineString');
    return coords;
  }

  private beginRide(): void {
    if (this.timer) clearTimeout(this.timer);
    const prefillMs = this.opts.prefillS * 1000;
    const start = Date.now() - prefillMs;
    this.ride = new SimulatedRide(this.route!, this.opts, start);
    // Prefill: run the first minutes instantly, back-dated.
    for (let i = 0; i < this.opts.prefillS; i++) {
      for (const m of this.ride.step())
        this.emitMessage(m.topic, JSON.stringify(m.payload), this.ride.simTime);
    }
    this.paused = false;
    this.nextTick = performance.now();
    this.schedule();
  }

  private schedule(): void {
    const interval = 1000 / Math.max(0.1, this.opts.speed);
    this.nextTick += interval;
    const delay = Math.max(0, this.nextTick - performance.now());
    this.timer = setTimeout(() => this.tick(), delay);
  }

  private tick(): void {
    if (!this.ride) return;
    if (!this.paused) {
      // Keep simulated time aligned with the wall clock at 1x; at higher
      // speeds it runs ahead, which is what a fast-forward should do.
      for (const m of this.ride.step()) this.emitMessage(m.topic, JSON.stringify(m.payload));
    } else {
      this.nextTick = performance.now();
    }
    this.schedule();
  }
}

/**
 * Chooses which data source feeds the store and handles the switch from
 * simulated to real data.
 *
 *   - The app starts in simulation.
 *   - An MQTT connection can be opened at any time; it listens alongside
 *     the simulation. The moment the first real condition message arrives
 *     the simulation is stopped, its data cleared and the live data takes
 *     over. The UI is told so it can fade and show "Live data from bike1".
 *   - If live data stops for longer than the configured time, a "no data"
 *     state is raised. The app never falls back to simulation on its own.
 *   - A replay of a recorded log can be loaded at any time and replaces
 *     whatever is running.
 */
import { parseMessage, type ParseContext } from '../contract';
import type { RideStore, SourceKind } from '../store';
import type { AppConfig } from '../../config/types';
import { Emitter } from '../../utils/events';
import type { DataSource, SourceStatus } from './DataSource';
import { MqttSource, type MqttOptions } from './MqttSource';
import { ReplaySource, type ReplayRecord } from './ReplaySource';
import { SimulatedSource } from './SimulatedSource';

type ManagerEvents = {
  /** Fired just before the store is cleared for a source change. */
  switching: { from: SourceKind; to: SourceKind; device?: string };
  /** Fired after the switch has completed. */
  switched: { kind: SourceKind; device?: string };
  mqtt: { status: SourceStatus; detail?: string };
  replay: { status: SourceStatus; detail?: string };
  stale: { stale: boolean; sinceMs: number };
  message: { topic: string; kind: SourceKind; receivedAt: number };
};

export class SourceManager extends Emitter<ManagerEvents> {
  readonly sim: SimulatedSource;
  mqtt: MqttSource | null = null;
  replay: ReplaySource | null = null;
  private lastLiveAt = 0;
  private stale = false;
  private watchdog: ReturnType<typeof setInterval> | null = null;
  /** Live messages ignored while a replay is running. */
  ignoredLive = 0;

  constructor(
    private readonly store: RideStore,
    private cfg: AppConfig,
    baseUrl: string,
  ) {
    super();
    this.sim = new SimulatedSource(`${baseUrl}${cfg.simulator.routeUrl}`, {
      topicPrefix: cfg.broker.topicPrefix,
      classIds: cfg.classes.map((c) => c.id),
      speed: cfg.simulator.speed,
      prefillS: cfg.simulator.prefillS,
      secondBike: cfg.simulator.secondBike,
      errorRate: cfg.simulator.errorRate,
      bikeIds: ['bike1', 'bike2'],
    });
    this.sim.onMessage((topic, payload, receivedAt) =>
      this.handle(this.sim, topic, payload, receivedAt),
    );
    this.watchdog = setInterval(() => this.checkStale(), 1000);
  }

  setConfig(cfg: AppConfig): void {
    this.cfg = cfg;
    this.sim.updateOptions({
      topicPrefix: cfg.broker.topicPrefix,
      classIds: cfg.classes.map((c) => c.id),
      errorRate: cfg.simulator.errorRate,
    });
    this.sim.setSpeed(cfg.simulator.speed);
    this.sim.setSecondBike(cfg.simulator.secondBike);
  }

  get mode(): SourceKind {
    return this.store.sourceKind;
  }

  private parseContext(receivedAt: number): ParseContext {
    return {
      topicPrefix: this.cfg.broker.topicPrefix,
      classIds: this.cfg.classes.map((c) => c.id),
      aliases: this.cfg.aliases,
      owntracksMap: this.cfg.broker.owntracksMap,
      owntracksDefaultBike: this.cfg.broker.owntracksDefaultBike,
      receivedAt,
    };
  }

  // ------------------------------------------------------------- routing

  private handle(source: DataSource, topic: string, payload: string, receivedAt: number): void {
    const mode = this.store.sourceKind;
    const msg = parseMessage(topic, payload, this.parseContext(receivedAt));

    if (source.kind === 'live') {
      if (mode === 'replay') {
        this.ignoredLive++;
        return;
      }
      if (mode === 'simulated') {
        // Only a condition result counts as "the system is alive"; a phone
        // sending GPS on its own should not throw the simulation away.
        if (msg?.kind !== 'condition') return;
        this.switchTo('live', msg.device);
      }
      this.lastLiveAt = receivedAt;
      if (this.stale) {
        this.stale = false;
        this.emit('stale', { stale: false, sinceMs: 0 });
      }
    } else if (source.kind !== mode) {
      return; // a stopped source draining its last timer
    }

    if (msg) {
      this.store.ingest(msg, { topic, payload });
      this.emit('message', { topic, kind: source.kind, receivedAt });
    }
  }

  private switchTo(kind: SourceKind, device?: string): void {
    const from = this.store.sourceKind;
    if (from === kind) return;
    this.emit('switching', { from, to: kind, device });
    if (from === 'simulated') this.sim.stop();
    if (from === 'replay') {
      this.replay?.stop();
      this.replay = null;
    }
    this.store.reset();
    this.store.setSourceKind(kind);
    if (kind === 'live') this.lastLiveAt = Date.now();
    this.emit('switched', { kind, device });
  }

  // ------------------------------------------------------------- controls

  /** Starts (or returns to) the simulation. */
  async useSimulation(): Promise<void> {
    if (this.store.sourceKind !== 'simulated') {
      this.switchTo('simulated');
    }
    await this.sim.start();
  }

  /** Opens the MQTT connection. The simulation keeps running until real data arrives. */
  async connect(opts: Omit<MqttOptions, 'topics'> & { topics?: string[] }): Promise<void> {
    this.disconnect();
    const topics = opts.topics?.length
      ? opts.topics
      : [
          `${this.cfg.broker.topicPrefix}/+/+`,
          `${this.cfg.broker.topicPrefix}/+/+/+`,
          ...this.cfg.broker.extraTopics,
        ];
    const src = new MqttSource({ ...opts, topics });
    src.onMessage((topic, payload, receivedAt) => this.handle(src, topic, payload, receivedAt));
    src.onStatus((status, detail) => this.emit('mqtt', { status, detail }));
    this.mqtt = src;
    await src.start();
  }

  disconnect(): void {
    if (!this.mqtt) return;
    this.mqtt.stop();
    this.mqtt = null;
    this.emit('mqtt', { status: 'idle' });
  }

  /** Switches to live mode by hand (useful when GPS-only data is arriving). */
  forceLive(): void {
    if (this.mqtt) this.switchTo('live');
  }

  /** Replaces the current source with a replay of a recorded log. */
  loadReplay(records: ReplayRecord[], name: string): ReplaySource {
    this.switchTo('replay');
    const src = new ReplaySource(records, name);
    src.onMessage((topic, payload, receivedAt) => this.handle(src, topic, payload, receivedAt));
    src.onStatus((status, detail) => this.emit('replay', { status, detail }));
    this.replay = src;
    src.start();
    return src;
  }

  /** Clears the ride. In simulation the ride starts again from the campus. */
  resetRide(): void {
    const kind = this.store.sourceKind;
    this.store.reset();
    if (kind === 'simulated') this.sim.restart();
    if (kind === 'replay') this.replay?.seek(0);
  }

  private checkStale(): void {
    if (this.store.sourceKind !== 'live' || !this.lastLiveAt) return;
    const since = Date.now() - this.lastLiveAt;
    const stale = since > this.cfg.broker.noDataTimeoutS * 1000;
    if (stale !== this.stale) {
      this.stale = stale;
      this.emit('stale', { stale, sinceMs: since });
    } else if (stale) {
      this.emit('stale', { stale, sinceMs: since });
    }
  }

  dispose(): void {
    if (this.watchdog) clearInterval(this.watchdog);
    this.sim.stop();
    this.disconnect();
    this.replay?.stop();
  }
}

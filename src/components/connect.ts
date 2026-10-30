/**
 * Source drawer: connect to the MQTT broker (credentials stay in the
 * browser), control the simulator, or load a recorded .jsonl log for replay.
 */
import type { ConfigStore } from '../config';
import type { SourceManager } from '../data/sources/SourceManager';
import { parseJsonl } from '../data/sources/ReplaySource';
import type { SourceStatus } from '../data/sources/DataSource';
import { el } from '../utils/dom';
import { formatClock } from '../utils/format';
import { Drawer } from './drawer';
import type { Toasts } from './toast';

const CRED_KEY = 'rsm.connection.v1';

interface StoredConnection {
  url: string;
  username: string;
  password: string;
  topics: string;
  remember: boolean;
}

export class SourceDrawer {
  readonly drawer: Drawer;
  private url: HTMLInputElement;
  private user: HTMLInputElement;
  private pass: HTMLInputElement;
  private topics: HTMLInputElement;
  private remember: HTMLInputElement;
  private owntracks: HTMLTextAreaElement;
  private status: HTMLElement;
  private connectBtn: HTMLButtonElement;
  private disconnectBtn: HTMLButtonElement;
  private forceLiveBtn: HTMLButtonElement;
  private simBtns: HTMLButtonElement[] = [];
  private pauseBtn: HTMLButtonElement;
  private replayInfo: HTMLElement;
  private replayControls: HTMLElement;
  private replaySeek: HTMLInputElement;
  private replayPause: HTMLButtonElement;

  constructor(
    host: HTMLElement,
    private readonly config: ConfigStore,
    private readonly sources: SourceManager,
    private readonly toasts: Toasts,
  ) {
    this.drawer = new Drawer(host, 'Data source', 'drawer-source');
    const cfg = config.current;
    const stored = this.readStored();

    // --- MQTT
    this.url = el('input', {
      type: 'url',
      placeholder: 'wss://xxxx.s1.eu.hivemq.cloud:8884/mqtt',
      value: stored?.url || cfg.broker.wsUrl,
      autocomplete: 'off',
    });
    this.user = el('input', {
      type: 'text',
      placeholder: 'dashboard user',
      value: stored?.username || cfg.broker.username,
      autocomplete: 'off',
    });
    this.pass = el('input', {
      type: 'password',
      placeholder: 'password',
      value: stored?.password ?? '',
      autocomplete: 'off',
    });
    this.topics = el('input', {
      type: 'text',
      value: stored?.topics || '',
      placeholder: `${cfg.broker.topicPrefix}/+/+, owntracks/#`,
    });
    this.remember = el('input', { type: 'checkbox', checked: stored?.remember ?? false });
    this.owntracks = el('textarea', { rows: '3', placeholder: 'user/device = bike1' });
    this.owntracks.value = Object.entries(cfg.broker.owntracksMap)
      .map(([k, v]) => `${k} = ${v}`)
      .join('\n');
    this.owntracks.addEventListener('change', () => {
      const map: Record<string, string> = {};
      for (const line of this.owntracks.value.split('\n')) {
        const m = line.match(/^\s*(?:owntracks\/)?([^=\s]+\/[^=\s]+)\s*=\s*(\S+)\s*$/);
        if (m) map[m[1]!] = m[2]!;
      }
      config.replaceSettings({
        ...config.exportSettings(),
        broker: { ...(config.exportSettings().broker ?? {}), owntracksMap: map },
      });
    });
    this.status = el('div', { class: 'conn-status', 'data-state': 'off', text: 'Not connected' });
    this.connectBtn = el('button', { class: 'btn btn-primary', type: 'button', text: 'Connect' });
    this.disconnectBtn = el('button', {
      class: 'btn',
      type: 'button',
      text: 'Disconnect',
      disabled: true,
    });
    this.forceLiveBtn = el('button', {
      class: 'btn btn-ghost',
      type: 'button',
      text: 'Switch to live now',
      disabled: true,
      title:
        'Normally the switch happens on the first condition message. Use this if only GPS is arriving.',
    });
    this.connectBtn.addEventListener('click', () => void this.connect());
    this.disconnectBtn.addEventListener('click', () => {
      sources.disconnect();
      this.setStatus('idle');
    });
    this.forceLiveBtn.addEventListener('click', () => sources.forceLive());

    const mqttSection = el('section', { class: 'settings-section' }, [
      el('h3', { class: 't-label', text: 'Live data over MQTT' }),
      el('label', { class: 'field' }, [
        el('span', { text: 'Broker WebSocket URL (wss, port 8884 on HiveMQ Cloud)' }),
        this.url,
      ]),
      el('div', { class: 'two-col' }, [
        el('label', { class: 'field' }, [el('span', { text: 'Username' }), this.user]),
        el('label', { class: 'field' }, [el('span', { text: 'Password' }), this.pass]),
      ]),
      el('label', { class: 'field' }, [
        el('span', { text: 'Topics (optional, comma separated)' }),
        this.topics,
      ]),
      el('label', { class: 'field' }, [
        el('span', { text: 'OwnTracks phone to bike (user/device = bike)' }),
        this.owntracks,
        el('span', {
          class: 'field-hint',
          text: `Unlisted phones go to ${cfg.broker.owntracksDefaultBike}`,
        }),
      ]),
      el('label', { class: 'field-row' }, [
        this.remember,
        el('span', { class: 'field-hint', text: 'Remember the password in this browser' }),
      ]),
      el('div', { class: 'field-row' }, [this.connectBtn, this.disconnectBtn, this.forceLiveBtn]),
      this.status,
    ]);

    // --- Simulator
    const simRow = el('div', { class: 'btn-group' });
    for (const s of [1, 4, 10]) {
      const b = el('button', {
        class: 'btn',
        type: 'button',
        text: `${s}x`,
        'aria-pressed': String(sources.sim.speed === s),
      });
      b.addEventListener('click', () => this.setSimSpeed(s));
      this.simBtns.push(b);
      simRow.append(b);
    }
    this.pauseBtn = el('button', { class: 'btn', type: 'button', text: 'Pause' });
    this.pauseBtn.addEventListener('click', () => {
      sources.sim.setPaused(!sources.sim.isPaused);
      this.pauseBtn.textContent = sources.sim.isPaused ? 'Resume' : 'Pause';
    });
    const restart = el('button', { class: 'btn', type: 'button', text: 'Restart ride' });
    restart.addEventListener('click', () => sources.resetRide());
    const useSim = el('button', {
      class: 'btn btn-primary',
      type: 'button',
      text: 'Use simulation',
    });
    useSim.addEventListener('click', () => void sources.useSimulation());
    const second = el('input', { type: 'checkbox', checked: cfg.simulator.secondBike });
    second.addEventListener('change', () => {
      config.update({ simulator: { secondBike: second.checked } });
      sources.sim.setSecondBike(second.checked);
    });
    const simSection = el('section', { class: 'settings-section' }, [
      el('h3', { class: 't-label', text: 'Simulation' }),
      el('p', {
        class: 'field-hint',
        text: 'A ride from the University of Twente campus to the Oude Markt along real streets, with cobbles, bumps and traffic lights.',
      }),
      el('div', { class: 'field-row' }, [useSim, simRow, this.pauseBtn, restart]),
      el('label', { class: 'field-row' }, [
        second,
        el('span', { class: 'field-hint', text: 'Second bike riding the route in reverse' }),
      ]),
    ]);

    // --- Replay
    const file = el('input', {
      type: 'file',
      accept: '.jsonl,.json,.txt,application/jsonl',
      hidden: true,
    });
    const load = el('button', {
      class: 'btn btn-primary',
      type: 'button',
      text: 'Load a .jsonl log',
    });
    load.addEventListener('click', () => file.click());
    file.addEventListener('change', async () => {
      const f = file.files?.[0];
      if (!f) return;
      const records = parseJsonl(await f.text());
      if (!records.length) {
        toasts.show('No messages found in that file', 'warn');
        return;
      }
      sources.loadReplay(records, f.name);
      toasts.show(`Replaying ${f.name} (${records.length} messages)`, 'ok');
      file.value = '';
    });
    const demo = el('button', { class: 'btn', type: 'button', text: 'Replay the demo ride' });
    demo.addEventListener('click', async () => {
      try {
        const res = await fetch(`${import.meta.env.BASE_URL}samples/demo-ride.jsonl`);
        const records = parseJsonl(await res.text());
        sources.loadReplay(records, 'demo-ride.jsonl');
        toasts.show(`Replaying the demo ride (${records.length} messages)`, 'ok');
      } catch {
        toasts.show('Demo ride not available', 'warn');
      }
    });
    this.replayInfo = el('div', { class: 'field-hint' });
    this.replaySeek = el('input', { type: 'range', min: '0', max: '1000', value: '0' });
    this.replaySeek.addEventListener('input', () => {
      const r = sources.replay;
      if (!r) return;
      r.seek((Number(this.replaySeek.value) / 1000) * r.duration, () => sources.resetRide());
    });
    this.replayPause = el('button', { class: 'btn', type: 'button', text: 'Pause' });
    this.replayPause.addEventListener('click', () => {
      const r = sources.replay;
      if (!r) return;
      r.setPaused(!r.isPaused);
      this.replayPause.textContent = r.isPaused ? 'Resume' : 'Pause';
    });
    const replaySpeeds = el('div', { class: 'btn-group' });
    for (const s of [1, 2, 5, 10]) {
      const b = el('button', {
        class: 'btn',
        type: 'button',
        text: `${s}x`,
        'aria-pressed': String(s === 1),
      });
      b.addEventListener('click', () => {
        sources.replay?.setSpeed(s);
        for (const x of replaySpeeds.children) x.setAttribute('aria-pressed', String(x === b));
      });
      replaySpeeds.append(b);
    }
    this.replayControls = el('div', { class: 'replay-controls', hidden: true }, [
      el('div', { class: 'field-row' }, [this.replayPause, replaySpeeds]),
      this.replaySeek,
      this.replayInfo,
    ]);
    const replaySection = el('section', { class: 'settings-section' }, [
      el('h3', { class: 't-label', text: 'Replay a recorded ride' }),
      el('div', { class: 'field-row' }, [load, demo, file]),
      this.replayControls,
    ]);

    this.drawer.body.append(mqttSection, simSection, replaySection);

    sources.on('mqtt', ({ status, detail }) => this.setStatus(status, detail));
    sources.on('replay', ({ status, detail }) => {
      this.replayControls.hidden = !sources.replay;
      if (status === 'ended') this.replayInfo.textContent = detail ?? 'End of log';
    });
    setInterval(() => this.tickReplay(), 500);
  }

  private readStored(): StoredConnection | null {
    try {
      const raw = localStorage.getItem(CRED_KEY);
      return raw ? (JSON.parse(raw) as StoredConnection) : null;
    } catch {
      return null;
    }
  }

  private persist(): void {
    const data: StoredConnection = {
      url: this.url.value.trim(),
      username: this.user.value.trim(),
      password: this.remember.checked ? this.pass.value : '',
      topics: this.topics.value.trim(),
      remember: this.remember.checked,
    };
    try {
      localStorage.setItem(CRED_KEY, JSON.stringify(data));
    } catch {
      /* ignore */
    }
  }

  private setSimSpeed(s: number): void {
    this.sources.sim.setSpeed(s);
    this.config.update({ simulator: { speed: s } });
    for (const b of this.simBtns) b.setAttribute('aria-pressed', String(b.textContent === `${s}x`));
  }

  syncSimSpeed(): void {
    for (const b of this.simBtns)
      b.setAttribute('aria-pressed', String(b.textContent === `${this.sources.sim.speed}x`));
  }

  async connect(): Promise<void> {
    const url = this.url.value.trim();
    if (!url) {
      this.toasts.show('Enter the broker WebSocket URL first', 'warn');
      this.url.focus();
      return;
    }
    if (!/^wss?:\/\//i.test(url)) {
      this.toasts.show('The URL must start with wss:// (or ws:// for a local broker)', 'warn');
      return;
    }
    if (location.protocol === 'https:' && url.startsWith('ws://')) {
      this.toasts.show('A page served over https can only use wss://', 'warn');
      return;
    }
    this.persist();
    const topics = this.topics.value
      .split(',')
      .map((t) => t.trim())
      .filter(Boolean);
    try {
      await this.sources.connect({
        url,
        username: this.user.value.trim(),
        password: this.pass.value,
        topics,
      });
    } catch (err) {
      this.setStatus('error', err instanceof Error ? err.message : String(err));
    }
  }

  /** Connects automatically with stored or configured credentials, if any. */
  autoConnect(): void {
    const stored = this.readStored();
    if (stored?.remember && stored.url && stored.password) void this.connect();
  }

  private setStatus(status: SourceStatus, detail?: string): void {
    const text: Record<SourceStatus, string> = {
      idle: 'Not connected',
      starting: 'Connecting',
      running: 'Connected',
      paused: 'Paused',
      offline: 'Offline, reconnecting',
      error: 'Error',
      ended: 'Closed',
    };
    this.status.dataset.state = status;
    this.status.textContent = detail ? `${text[status]}: ${detail}` : text[status];
    const on = status !== 'idle' && status !== 'ended';
    this.connectBtn.disabled = on && status !== 'error';
    this.disconnectBtn.disabled = !on;
    this.forceLiveBtn.disabled = status !== 'running';
  }

  private tickReplay(): void {
    const r = this.sources.replay;
    if (!r || this.replayControls.hidden) return;
    if (document.activeElement !== this.replaySeek)
      this.replaySeek.value = String(Math.round((r.position / Math.max(1, r.duration)) * 1000));
    this.replayInfo.textContent = `${r.name}: ${formatClock(r.position / 1000)} of ${formatClock(r.duration / 1000)} at ${r.speed}x${this.sources.ignoredLive ? `, ${this.sources.ignoredLive} live messages ignored during replay` : ''}`;
  }
}

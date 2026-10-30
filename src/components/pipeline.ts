/**
 * System pipeline overlay: the architecture as a live diagram. Each real
 * message animates as a small packet along its path and every stage shows
 * live numbers (rate, last value, latency). Each block is mapped to one of
 * the four IoT components: sensing, connectivity, data processing and the
 * user interface.
 */
import type { RideStore, SourceKind } from '../data/store';
import { el, svgEl } from '../utils/dom';
import { formatFixed } from '../utils/format';

interface Stage {
  id: string;
  title: string;
  sub: string;
  component: 'Sensing' | 'Connectivity' | 'Data processing' | 'User interface';
  x: number;
  y: number;
}

const STAGES: Stage[] = [
  {
    id: 'thingy',
    title: 'Thingy:52',
    sub: 'IMU, accelerometer and gyroscope',
    component: 'Sensing',
    x: 90,
    y: 150,
  },
  {
    id: 'pi',
    title: 'Raspberry Pi 5',
    sub: 'Edge Impulse classifier',
    component: 'Data processing',
    x: 330,
    y: 150,
  },
  {
    id: 'broker',
    title: 'MQTT broker',
    sub: 'HiveMQ Cloud, TLS',
    component: 'Connectivity',
    x: 600,
    y: 150,
  },
  {
    id: 'dash',
    title: 'Dashboard',
    sub: 'this browser, WSS',
    component: 'User interface',
    x: 850,
    y: 150,
  },
  {
    id: 'phone',
    title: 'Phone',
    sub: 'GPS via OwnTracks, hotspot',
    component: 'Sensing',
    x: 330,
    y: 330,
  },
];

interface Link {
  from: string;
  to: string;
  label: string;
}

const LINKS: Link[] = [
  { from: 'thingy', to: 'pi', label: 'Bluetooth Low Energy' },
  { from: 'pi', to: 'broker', label: 'MQTT over TLS, 8883' },
  { from: 'broker', to: 'dash', label: 'MQTT over WebSocket, 8884' },
  { from: 'phone', to: 'broker', label: 'MQTT (OwnTracks)' },
];

const BOX_W = 180;
const BOX_H = 86;

export class PipelineView {
  readonly root: HTMLElement;
  private svg: SVGSVGElement;
  private packets: SVGGElement;
  private counters = new Map<
    string,
    { n: number; last: number; recent: number[]; lastText: string }
  >();
  private numberNodes = new Map<string, HTMLElement>();
  private lastTick = 0;
  private open = false;
  private kind: SourceKind = 'simulated';
  private bleStream: SVGCircleElement[] = [];
  private motion: () => number;

  constructor(
    host: HTMLElement,
    private readonly store: RideStore,
    motion: () => number,
    onClose: () => void,
  ) {
    this.motion = motion;
    this.svg = svgEl('svg', {
      viewBox: '0 0 960 420',
      class: 'pipeline-svg',
      'aria-hidden': 'true',
    });
    this.packets = svgEl('g', { class: 'pipeline-packets' });
    const closeBtn = el('button', { class: 'btn', type: 'button', text: 'Close (P)' });
    closeBtn.addEventListener('click', onClose);
    const legend = el('div', { class: 'pipeline-legend' }, [
      ...(['Sensing', 'Connectivity', 'Data processing', 'User interface'] as const).map((c) =>
        el('span', { class: 'pipeline-legend-item', 'data-component': c }, [
          el('i'),
          el('span', { text: c }),
        ]),
      ),
    ]);
    const boxes = el('div', { class: 'pipeline-boxes' });
    for (const s of STAGES) {
      const numbers = el('div', { class: 'pipeline-numbers t-num' });
      this.numberNodes.set(s.id, numbers);
      const box = el(
        'div',
        { class: 'pipeline-box', 'data-component': s.component, 'data-stage': s.id },
        [
          el('span', { class: 'pipeline-component t-label', text: s.component }),
          el('span', { class: 'pipeline-title t-display', text: s.title }),
          el('span', { class: 'pipeline-sub', text: s.sub }),
          numbers,
        ],
      );
      box.style.left = `${((s.x - BOX_W / 2) / 960) * 100}%`;
      box.style.top = `${((s.y - BOX_H / 2) / 420) * 100}%`;
      box.style.width = `${(BOX_W / 960) * 100}%`;
      box.style.height = `${(BOX_H / 420) * 100}%`;
      boxes.append(box);
    }
    this.root = el(
      'div',
      { class: 'pipeline', role: 'dialog', 'aria-label': 'System pipeline', hidden: true },
      [
        el('div', { class: 'pipeline-head' }, [
          el('div', {}, [
            el('h2', { class: 't-display', text: 'System pipeline' }),
            el('p', {
              class: 'pipeline-intro',
              text: 'Live view of the data path. Packets move as messages arrive. The four IoT components are marked on each block.',
            }),
          ]),
          closeBtn,
        ]),
        el('div', { class: 'pipeline-stage' }, [this.svg, boxes]),
        legend,
      ],
    );
    host.append(this.root);
    this.drawLinks();
    for (const s of STAGES) this.counters.set(s.id, { n: 0, last: 0, recent: [], lastText: '' });

    store.on('condition', ({ device, sample }) => {
      this.note(
        'thingy',
        `${device.id}: ${sample.vibMeasured ? sample.vib.toFixed(1) + ' m/s²' : 'window'}`,
      );
      this.note(
        'pi',
        `${sample.label} ${Math.round(sample.confidence * 100)}%${sample.inferenceMs != null ? `, ${sample.inferenceMs.toFixed(1)} ms` : ''}`,
      );
      this.note('broker', `${device.id}/condition`);
      this.note('dash', `latency ${Math.round(sample.latencyMs)} ms`);
      this.packet('thingy', 'pi', 'cond');
      this.packet('pi', 'broker', 'cond', 350);
      this.packet('broker', 'dash', 'cond', 700);
    });
    store.on('gps', ({ device, fix }) => {
      this.note(
        'phone',
        `${fix.lat.toFixed(5)}, ${fix.lon.toFixed(5)}${fix.speed != null ? `, ${fix.speed.toFixed(0)} km/h` : ''} (${device.id})`,
      );
      this.packet('phone', 'broker', 'gps');
      this.packet('broker', 'dash', 'gps', 350);
    });
    store.on('source-kind', (k) => (this.kind = k));
  }

  get isOpen(): boolean {
    return this.open;
  }

  toggle(force?: boolean): void {
    this.open = force ?? !this.open;
    this.root.hidden = !this.open;
    this.root.dataset.kind = this.kind;
  }

  private centre(id: string): [number, number] {
    const s = STAGES.find((x) => x.id === id)!;
    return [s.x, s.y];
  }

  private pathFor(from: string, to: string): string {
    const [x1, y1] = this.centre(from);
    const [x2, y2] = this.centre(to);
    if (y1 === y2) return `M${x1 + BOX_W / 2} ${y1} L${x2 - BOX_W / 2} ${y2}`;
    // Phone -> broker: a gentle curve up to the broker.
    return `M${x1 + BOX_W / 2} ${y1} C ${x1 + 160} ${y1}, ${x2 - 160} ${y2 + 20}, ${x2 - BOX_W / 2} ${y2 + 20}`;
  }

  private drawLinks(): void {
    for (const l of LINKS) {
      const d = this.pathFor(l.from, l.to);
      this.svg.append(svgEl('path', { d, class: 'pipeline-link', id: `link-${l.from}-${l.to}` }));
      const text = svgEl('text', { class: 'pipeline-link-label', dy: -8 });
      const tp = svgEl('textPath', {
        href: `#link-${l.from}-${l.to}`,
        startOffset: '50%',
        'text-anchor': 'middle',
      });
      tp.textContent = l.label;
      text.append(tp);
      this.svg.append(text);
    }
    // A continuous BLE stream between the Thingy and the Pi.
    for (let i = 0; i < 4; i++) {
      const c = svgEl('circle', { r: 3, class: 'pipeline-stream' });
      this.svg.append(c);
      this.bleStream.push(c);
    }
    this.svg.append(this.packets);
  }

  private note(stage: string, text: string): void {
    const c = this.counters.get(stage);
    if (!c) return;
    c.n++;
    c.last = Date.now();
    c.recent.push(c.last);
    if (c.recent.length > 60) c.recent.shift();
    c.lastText = text;
  }

  private packet(from: string, to: string, kind: 'cond' | 'gps', delay = 0): void {
    if (!this.open || this.motion() === 0) return;
    // Cap the number of packets in flight so a burst (replay at 10x) stays light.
    if (this.packets.childElementCount > 40) return;
    const path = this.svg.querySelector<SVGPathElement>(`#link-${from}-${to}`);
    if (!path) return;
    const len = path.getTotalLength();
    const dot = svgEl('circle', {
      r: kind === 'cond' ? 6 : 4.5,
      class: `pipeline-packet is-${kind}`,
    });
    this.packets.append(dot);
    const start = performance.now() + delay;
    const dur = 650;
    const step = (now: number) => {
      const t = (now - start) / dur;
      if (t < 0) {
        requestAnimationFrame(step);
        return;
      }
      if (t >= 1 || !this.open) {
        dot.remove();
        return;
      }
      const e = 1 - (1 - t) ** 2;
      const p = path.getPointAtLength(len * e);
      dot.setAttribute('cx', String(p.x));
      dot.setAttribute('cy', String(p.y));
      dot.setAttribute('opacity', String(t < 0.1 ? t / 0.1 : t > 0.85 ? (1 - t) / 0.15 : 1));
      requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }

  frame(now: number): void {
    if (!this.open) return;
    // BLE stream dots.
    const ble = this.svg.querySelector<SVGPathElement>('#link-thingy-pi');
    if (ble && this.motion() > 0) {
      const len = ble.getTotalLength();
      const live = this.store.deviceList.some((d) => Date.now() - d.lastConditionAt < 5000);
      this.bleStream.forEach((c, i) => {
        const t = (((now / 1400 + i / 4) % 1) + 1) % 1;
        const p = ble.getPointAtLength(len * t);
        c.setAttribute('cx', String(p.x));
        c.setAttribute('cy', String(p.y));
        c.setAttribute('opacity', live ? '0.6' : '0.15');
      });
    }
    if (now - this.lastTick < 400) return;
    this.lastTick = now;
    const nowMs = Date.now();
    for (const [id, c] of this.counters) {
      const node = this.numberNodes.get(id)!;
      const rate = c.recent.filter((t) => nowMs - t < 10_000).length / 10;
      const age = c.last ? (nowMs - c.last) / 1000 : null;
      node.replaceChildren(
        el('span', { text: `${formatFixed(rate, 1)} msg/s` }),
        el('span', {
          text: age == null ? 'no data yet' : age < 1 ? 'just now' : `${age.toFixed(0)} s ago`,
        }),
        el('span', { class: 'pipeline-last', text: c.lastText }),
      );
    }
  }
}

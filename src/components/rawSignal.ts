/**
 * Raw signal drawer: loads CSV files exported from Edge Impulse data
 * acquisition (timestamp, accX, accY, accZ and optionally gyroX..Z) and
 * plots the raw IMU signals, one panel per label, so the panel can see what
 * each road condition looks like as sensor data.
 *
 * Column names vary between exports; the parser accepts timestamp/time/ms,
 * accX/acc_x/ax/accelerometer_x and the same for gyro, in any order. The
 * label comes from a "label" column when present, otherwise from the file
 * name (Edge Impulse names files "<label>.<id>.csv").
 */
import { el } from '../utils/dom';
import { Drawer } from './drawer';
import type { ThemeManager } from './theme';

export interface SignalSample {
  label: string;
  name: string;
  t: number[];
  acc: [number[], number[], number[]];
  gyro: [number[], number[], number[]] | null;
}

function findColumn(headers: string[], candidates: RegExp[]): number {
  for (const re of candidates) {
    const i = headers.findIndex((h) => re.test(h));
    if (i >= 0) return i;
  }
  return -1;
}

/** Parses one CSV text. Exported for tests. */
export function parseSignalCsv(text: string, fileName: string): SignalSample | null {
  const lines = text.split(/\r?\n/).filter((l) => l.trim() && !l.startsWith('#'));
  if (lines.length < 3) return null;
  const sep =
    lines[0]!.includes(';') && !lines[0]!.includes(',')
      ? ';'
      : lines[0]!.includes('\t')
        ? '\t'
        : ',';
  const headers = lines[0]!.split(sep).map((h) => h.trim().replace(/^"|"$/g, '').toLowerCase());
  const col = {
    t: findColumn(headers, [/^timestamp$/, /^time/, /^ms$/, /^t$/]),
    ax: findColumn(headers, [/^acc[_ ]?x$/, /^ax$/, /accel.*x/, /^x$/]),
    ay: findColumn(headers, [/^acc[_ ]?y$/, /^ay$/, /accel.*y/, /^y$/]),
    az: findColumn(headers, [/^acc[_ ]?z$/, /^az$/, /accel.*z/, /^z$/]),
    gx: findColumn(headers, [/^gyr[o]?[_ ]?x$/, /^gx$/, /gyro.*x/]),
    gy: findColumn(headers, [/^gyr[o]?[_ ]?y$/, /^gy$/, /gyro.*y/]),
    gz: findColumn(headers, [/^gyr[o]?[_ ]?z$/, /^gz$/, /gyro.*z/]),
    label: findColumn(headers, [/^label$/, /^class$/]),
  };
  if (col.ax < 0 || col.ay < 0 || col.az < 0) return null;
  const out: SignalSample = {
    label: '',
    name: fileName,
    t: [],
    acc: [[], [], []],
    gyro: col.gx >= 0 && col.gy >= 0 && col.gz >= 0 ? [[], [], []] : null,
  };
  let i = 0;
  for (const line of lines.slice(1)) {
    const cells = line.split(sep);
    const n = (k: number) => Number(cells[k]);
    const ax = n(col.ax);
    const ay = n(col.ay);
    const az = n(col.az);
    if (![ax, ay, az].every(Number.isFinite)) continue;
    out.t.push(col.t >= 0 && Number.isFinite(n(col.t)) ? n(col.t) : i);
    out.acc[0].push(ax);
    out.acc[1].push(ay);
    out.acc[2].push(az);
    if (out.gyro) {
      out.gyro[0].push(n(col.gx));
      out.gyro[1].push(n(col.gy));
      out.gyro[2].push(n(col.gz));
    }
    if (!out.label && col.label >= 0 && cells[col.label])
      out.label = cells[col.label]!.trim().toLowerCase();
    i++;
  }
  if (!out.label) {
    const base = fileName.split('/').pop() ?? fileName;
    out.label = (base.split('.')[0] ?? 'sample').toLowerCase().replace(/[_-]?\d+$/, '');
  }
  return out.t.length > 2 ? out : null;
}

export class RawSignalDrawer {
  readonly drawer: Drawer;
  private panels: HTMLElement;
  private samples: SignalSample[] = [];

  constructor(
    host: HTMLElement,
    private readonly theme: ThemeManager,
    private readonly conditionColour: (label: string) => string,
  ) {
    this.drawer = new Drawer(host, 'Raw IMU signals', 'drawer-signals');
    const input = el('input', {
      type: 'file',
      accept: '.csv,text/csv',
      multiple: true,
      hidden: true,
    });
    const pick = el('button', { class: 'btn btn-primary', type: 'button', text: 'Load CSV files' });
    pick.addEventListener('click', () => input.click());
    input.addEventListener('change', async () => {
      for (const f of input.files ?? []) {
        const parsed = parseSignalCsv(await f.text(), f.name);
        if (parsed) this.samples.push(parsed);
      }
      input.value = '';
      this.render();
    });
    const clear = el('button', { class: 'btn btn-ghost', type: 'button', text: 'Clear' });
    clear.addEventListener('click', () => {
      this.samples = [];
      this.render();
    });
    this.panels = el('div', { class: 'signal-panels' });
    this.drawer.body.append(
      el('p', {
        class: 'field-hint',
        text: 'Export samples from Edge Impulse (Data acquisition, the three dots next to a sample, Download CSV) and load one or more here. Expected columns: timestamp, accX, accY, accZ, optionally gyroX, gyroY, gyroZ. The label is read from a label column or from the file name (smooth.abc123.csv).',
      }),
      el('div', { class: 'field-row' }, [pick, clear, input]),
      this.panels,
    );
    theme.on('change', () => this.render());
  }

  private render(): void {
    this.panels.replaceChildren();
    if (!this.samples.length) {
      this.panels.append(el('p', { class: 'report-empty', text: 'No files loaded yet.' }));
      return;
    }
    // Shared scale across panels so the labels compare directly.
    let amax = 1;
    for (const s of this.samples)
      for (const axis of s.acc) for (const v of axis) amax = Math.max(amax, Math.abs(v));
    amax = Math.ceil(amax / 5) * 5;
    for (const s of this.samples) {
      const canvas = el('canvas', { class: 'signal-canvas', width: '640', height: '160' });
      const head = el('div', { class: 'signal-head' }, [
        el('span', { class: 'signal-label t-display', text: s.label }),
        el('span', {
          class: 'field-hint t-num',
          text: `${s.name}, ${s.t.length} samples${s.gyro ? ', accelerometer and gyroscope' : ''}`,
        }),
      ]);
      head.style.setProperty('--c', this.conditionColour(s.label));
      this.panels.append(el('div', { class: 'signal-panel' }, [head, canvas]));
      this.plot(canvas, s, amax);
    }
  }

  private plot(canvas: HTMLCanvasElement, s: SignalSample, amax: number): void {
    const ctx = canvas.getContext('2d')!;
    const p = this.theme.palette;
    const w = canvas.width;
    const h = canvas.height;
    ctx.clearRect(0, 0, w, h);
    const pad = { l: 36, r: 8, t: 8, b: 18 };
    const pw = w - pad.l - pad.r;
    const ph = h - pad.t - pad.b;
    const n = s.t.length;
    const y = (v: number) => pad.t + ph / 2 - (v / amax) * (ph / 2);
    ctx.strokeStyle = p.line;
    ctx.lineWidth = 1;
    for (const v of [-amax, 0, amax]) {
      ctx.beginPath();
      ctx.moveTo(pad.l, y(v) + 0.5);
      ctx.lineTo(w - pad.r, y(v) + 0.5);
      ctx.stroke();
      ctx.fillStyle = p.ink3;
      ctx.font = `10px ${p.fontMono}`;
      ctx.textAlign = 'right';
      ctx.fillText(String(v), pad.l - 4, y(v) + 3);
    }
    const colours = [p.accent, p.conditions.rough ?? p.ink2, p.conditions.bump ?? p.ink3];
    const names = ['x', 'y', 'z'];
    s.acc.forEach((axis, i) => {
      ctx.strokeStyle = colours[i]!;
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      for (let k = 0; k < n; k++) {
        const px = pad.l + (k / (n - 1)) * pw;
        const py = y(axis[k]!);
        if (k === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      }
      ctx.stroke();
      ctx.fillStyle = colours[i]!;
      ctx.font = `10px ${p.fontMono}`;
      ctx.textAlign = 'left';
      ctx.fillText(`acc${names[i]}`, pad.l + 4 + i * 40, h - 5);
    });
    if (s.gyro) {
      let gmax = 1;
      for (const axis of s.gyro) for (const v of axis) gmax = Math.max(gmax, Math.abs(v));
      s.gyro.forEach((axis, i) => {
        ctx.strokeStyle = colours[i]!;
        ctx.globalAlpha = 0.45;
        ctx.setLineDash([3, 3]);
        ctx.beginPath();
        for (let k = 0; k < n; k++) {
          const px = pad.l + (k / (n - 1)) * pw;
          const py = pad.t + ph / 2 - (axis[k]! / gmax) * (ph / 2);
          if (k === 0) ctx.moveTo(px, py);
          else ctx.lineTo(px, py);
        }
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.globalAlpha = 1;
      });
      ctx.fillStyle = p.ink3;
      ctx.fillText('dashed: gyro (own scale)', pad.l + 130, h - 5);
    }
    const span = (s.t[n - 1] ?? 0) - (s.t[0] ?? 0);
    ctx.fillStyle = p.ink3;
    ctx.textAlign = 'right';
    ctx.fillText(span > 0 ? `${(span / 1000).toFixed(1)} s` : `${n} samples`, w - pad.r, h - 5);
  }
}

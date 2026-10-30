/**
 * The ride timeline: vibration trace (top), class probabilities as stacked
 * bands (middle), condition strip with bump pins and stops (bottom), a time
 * axis in mm:ss, a hover crosshair linked to a ghost marker on the map, and
 * a scrubber that replays the ride at 1x to 10x.
 *
 * Hand-drawn on a canvas: a few thousand samples redraw in well under a
 * millisecond and the look matches the rest of the app exactly.
 */
import type { AppConfig } from '../config/types';
import type { DeviceState, RideStore, Sample } from '../data/store';
import { el } from '../utils/dom';
import { clamp, formatClock, formatTime } from '../utils/format';
import type { ThemeManager } from './theme';
import { withAlpha } from './theme';

export interface TimelineCallbacks {
  onHover(ts: number | null): void;
  onClick(ts: number): void;
}

const SPEEDS = [1, 2, 5, 10];

export class Timeline {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private tooltip: HTMLElement;
  private playBtn: HTMLButtonElement;
  private speedBtn: HTMLButtonElement;
  private liveBtn: HTMLButtonElement;
  private clock: HTMLElement;
  private hoverX: number | null = null;
  private hoverTs: number | null = null;
  private dragging = false;
  private playing = false;
  private rate = 1;
  private lastFrame = 0;
  private cfg: AppConfig;
  private layout = { left: 44, right: 12, top: 8, axis: 18, vibH: 0, probH: 0, stripH: 14, gap: 6 };
  private needsDraw = true;
  private lastSampleCount = -1;
  private lastWidth = 0;

  constructor(
    private readonly root: HTMLElement,
    private readonly store: RideStore,
    private readonly theme: ThemeManager,
    cfg: AppConfig,
    private readonly cb: TimelineCallbacks,
  ) {
    this.cfg = cfg;
    this.canvas = el('canvas', { class: 'timeline-canvas' });
    this.ctx = this.canvas.getContext('2d')!;
    this.tooltip = el('div', { class: 'timeline-tip', hidden: true });
    this.playBtn = el('button', {
      class: 'btn btn-icon btn-ghost',
      type: 'button',
      title: 'Play or pause the replay (Space)',
      'aria-label': 'Play',
    });
    this.speedBtn = el('button', {
      class: 'btn btn-ghost t-num',
      type: 'button',
      title: 'Replay speed',
      text: '1x',
    });
    this.liveBtn = el('button', {
      class: 'btn btn-ghost',
      type: 'button',
      title: 'Back to live',
      text: 'Live',
    });
    this.clock = el('span', { class: 'timeline-clock t-num' });
    const bar = el('div', { class: 'timeline-bar' }, [
      el('span', { class: 't-label', text: 'Ride timeline' }),
      el('div', { class: 'timeline-controls' }, [
        this.playBtn,
        this.speedBtn,
        this.clock,
        this.liveBtn,
      ]),
    ]);
    root.append(bar, el('div', { class: 'timeline-plot' }, [this.canvas, this.tooltip]));
    this.setPlayIcon();

    this.playBtn.addEventListener('click', () => this.togglePlay());
    this.speedBtn.addEventListener('click', () => {
      this.rate = SPEEDS[(SPEEDS.indexOf(this.rate) + 1) % SPEEDS.length] ?? 1;
      this.speedBtn.textContent = `${this.rate}x`;
    });
    this.liveBtn.addEventListener('click', () => this.goLive());

    this.canvas.addEventListener('pointermove', (e) => this.onPointer(e, false));
    this.canvas.addEventListener('pointerdown', (e) => {
      this.canvas.setPointerCapture(e.pointerId);
      this.dragging = true;
      this.onPointer(e, true);
    });
    this.canvas.addEventListener('pointerup', (e) => {
      this.dragging = false;
      this.canvas.releasePointerCapture(e.pointerId);
      const ts = this.tsAt(e.offsetX);
      if (ts != null && e.detail > 0) this.cb.onClick(ts);
    });
    this.canvas.addEventListener('pointerleave', () => {
      if (this.dragging) return;
      this.hoverX = null;
      this.hoverTs = null;
      this.tooltip.hidden = true;
      this.cb.onHover(null);
      this.needsDraw = true;
    });
    theme.on('change', () => (this.needsDraw = true));
    store.on('view', () => (this.needsDraw = true));
    store.on('reset', () => {
      this.playing = false;
      this.setPlayIcon();
      this.needsDraw = true;
    });
    store.on('device-selected', () => (this.needsDraw = true));
    new ResizeObserver(() => (this.needsDraw = true)).observe(this.canvas);
  }

  setConfig(cfg: AppConfig): void {
    this.cfg = cfg;
    this.needsDraw = true;
  }

  get isPlaying(): boolean {
    return this.playing;
  }

  togglePlay(): void {
    const range = this.store.timeRange;
    if (!range) return;
    if (this.playing) {
      this.playing = false;
    } else {
      // Playing from live starts from the beginning of the ride.
      if (this.store.viewTs == null) this.store.setView(range.start);
      this.playing = true;
    }
    this.setPlayIcon();
  }

  goLive(): void {
    this.playing = false;
    this.setPlayIcon();
    this.store.setView(null);
  }

  private setPlayIcon(): void {
    this.playBtn.innerHTML = this.playing
      ? '<svg viewBox="0 0 24 24"><path d="M7 5h4v14H7zM13 5h4v14h-4z" fill="currentColor"/></svg>'
      : '<svg viewBox="0 0 24 24"><path d="M7 4l12 8-12 8z" fill="currentColor"/></svg>';
    this.playBtn.setAttribute('aria-label', this.playing ? 'Pause' : 'Play');
    this.playBtn.setAttribute('aria-pressed', String(this.playing));
  }

  private plotWidth(): number {
    return this.canvas.clientWidth - this.layout.left - this.layout.right;
  }

  private range(): { start: number; end: number } | null {
    const r = this.store.timeRange;
    if (!r) return null;
    const end = Math.max(r.end, r.start + 60_000);
    return { start: r.start, end };
  }

  private tsAt(x: number): number | null {
    const r = this.range();
    if (!r) return null;
    const f = clamp((x - this.layout.left) / this.plotWidth(), 0, 1);
    return r.start + f * (r.end - r.start);
  }

  private xAt(ts: number): number {
    const r = this.range();
    if (!r) return this.layout.left;
    return this.layout.left + ((ts - r.start) / (r.end - r.start)) * this.plotWidth();
  }

  private onPointer(e: PointerEvent, press: boolean): void {
    const ts = this.tsAt(e.offsetX);
    if (ts == null) return;
    this.hoverX = e.offsetX;
    this.hoverTs = ts;
    this.cb.onHover(ts);
    if (this.dragging || press) {
      this.playing = false;
      this.setPlayIcon();
      this.store.setView(ts);
    }
    this.needsDraw = true;
    this.renderTooltip(ts, e.offsetX);
  }

  private renderTooltip(ts: number, x: number): void {
    const d = this.store.selected;
    const s = d ? this.store.sampleAt(d, ts) : null;
    if (!d || !s) {
      this.tooltip.hidden = true;
      return;
    }
    const cls = this.cfg.classes.find((c) => c.id === s.label);
    const pos = this.store.positionAt(d, ts);
    this.tooltip.hidden = false;
    this.tooltip.innerHTML =
      `<b style="color:var(--cond-${s.known ? s.label : 'unknown'})">${cls?.name ?? s.rawLabel}</b> ${Math.round(s.confidence * 100)}%` +
      `<br><span class="t-num">${formatClock((ts - d.firstTs) / 1000)}  ${formatTime(ts)}</span>` +
      `<br><span class="t-num">${s.vib.toFixed(1)} m/s²  ${pos?.speed != null ? pos.speed.toFixed(0) + ' km/h' : ''}</span>`;
    const w = this.canvas.clientWidth;
    this.tooltip.style.left = `${x + 12 + 160 > w ? x - 170 : x + 12}px`;
  }

  /** Advances the scrub playback and redraws when needed. */
  frame(now: number): void {
    const d = this.store.selected;
    if (this.playing && this.store.viewTs != null) {
      const dt = this.lastFrame ? now - this.lastFrame : 0;
      const next = this.store.viewTs + dt * this.rate;
      this.store.setView(next);
      if (this.store.viewTs == null) {
        this.playing = false;
        this.setPlayIcon();
      }
      this.needsDraw = true;
    }
    this.lastFrame = now;
    const count = d?.samples.length ?? 0;
    if (count !== this.lastSampleCount || this.canvas.clientWidth !== this.lastWidth) {
      this.lastSampleCount = count;
      this.lastWidth = this.canvas.clientWidth;
      this.needsDraw = true;
    }
    if (this.needsDraw) {
      this.needsDraw = false;
      this.draw();
    }
    const view = this.store.viewTs;
    const r = this.store.timeRange;
    if (d && r) {
      const t = view ?? r.end;
      this.clock.textContent = `${formatClock((t - d.firstTs) / 1000)} / ${formatClock((r.end - d.firstTs) / 1000)}`;
    } else this.clock.textContent = '';
    this.liveBtn.classList.toggle('is-active', view == null);
    this.root.classList.toggle('is-scrubbing', view != null);
  }

  private draw(): void {
    const c = this.canvas;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = c.clientWidth;
    const h = c.clientHeight;
    if (!w || !h) return;
    if (c.width !== Math.round(w * dpr) || c.height !== Math.round(h * dpr)) {
      c.width = Math.round(w * dpr);
      c.height = Math.round(h * dpr);
    }
    const ctx = this.ctx;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    const p = this.theme.palette;
    const L = this.layout;
    const d = this.store.selected;
    const r = this.range();
    const plotW = this.plotWidth();
    const hasScores = !!d?.samples.some((s) => s.scores);
    const inner = h - L.top - L.axis - L.stripH - L.gap * (hasScores ? 2 : 1);
    L.probH = hasScores ? Math.max(18, inner * 0.36) : 0;
    L.vibH = inner - L.probH;
    const vibTop = L.top;
    const probTop = vibTop + L.vibH + L.gap;
    const stripTop = probTop + L.probH + (hasScores ? L.gap : 0);
    const axisY = stripTop + L.stripH + 4;

    // Band labels.
    ctx.font = `600 9px ${p.fontDisplay}`;
    ctx.fillStyle = p.ink3;
    ctx.textAlign = 'right';
    ctx.textBaseline = 'top';
    ctx.fillText('VIB', L.left - 8, vibTop);
    ctx.fillText('m/s²', L.left - 8, vibTop + 11);
    if (hasScores) ctx.fillText('P', L.left - 8, probTop);
    ctx.fillText('ROAD', L.left - 8, stripTop);

    if (!d || !r || !d.samples.length) {
      ctx.textAlign = 'center';
      ctx.font = `12px ${p.fontText}`;
      ctx.fillText('Waiting for the first messages', L.left + plotW / 2, h / 2 - 6);
      return;
    }
    const samples = d.samples;
    const span = r.end - r.start;
    const x = (ts: number) => L.left + ((ts - r.start) / span) * plotW;

    // Vibration scale: at least 0..10 m/s^2.
    let vmax = 10;
    for (const s of samples) if (s.vib > vmax) vmax = s.vib;
    vmax = Math.ceil(vmax / 5) * 5;
    ctx.strokeStyle = p.line;
    ctx.lineWidth = 1;
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    ctx.font = `9px ${p.fontMono}`;
    for (const v of [0, vmax / 2, vmax]) {
      const y = vibTop + L.vibH - (v / vmax) * L.vibH;
      ctx.beginPath();
      ctx.moveTo(L.left, y + 0.5);
      ctx.lineTo(L.left + plotW, y + 0.5);
      ctx.stroke();
      ctx.fillStyle = p.ink3;
      ctx.fillText(String(v), L.left - 4 + 0, y);
    }

    // Vibration area and line.
    ctx.beginPath();
    ctx.moveTo(x(samples[0]!.ts), vibTop + L.vibH);
    for (const s of samples)
      ctx.lineTo(x(s.ts), vibTop + L.vibH - (clamp(s.vib, 0, vmax) / vmax) * L.vibH);
    ctx.lineTo(x(samples[samples.length - 1]!.ts), vibTop + L.vibH);
    ctx.closePath();
    ctx.fillStyle = withAlpha(p.accent, 0.16);
    ctx.fill();
    ctx.beginPath();
    for (let i = 0; i < samples.length; i++) {
      const s = samples[i]!;
      const px = x(s.ts);
      const py = vibTop + L.vibH - (clamp(s.vib, 0, vmax) / vmax) * L.vibH;
      if (i === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    }
    ctx.strokeStyle = p.accent;
    ctx.lineWidth = 1.2;
    ctx.stroke();

    // Probability bands: stacked per sample, one column per sample.
    if (hasScores) {
      const ids = this.cfg.classes.map((c) => c.id);
      for (let i = 0; i < samples.length; i++) {
        const s = samples[i]!;
        if (!s.scores) continue;
        const x0 = x(s.ts);
        const x1 = x(samples[i + 1]?.ts ?? s.ts + 1000);
        const cw = Math.max(1, x1 - x0 + 0.5);
        let y = probTop;
        for (const id of ids) {
          const v = s.scores[id] ?? 0;
          const hh = v * L.probH;
          ctx.fillStyle = p.conditions[id] ?? p.unknown;
          ctx.globalAlpha = id === s.label ? 0.9 : 0.45;
          ctx.fillRect(x0, y, cw, hh);
          y += hh;
        }
      }
      ctx.globalAlpha = 1;
    }

    // Condition strip.
    const patternOf = new Map(this.cfg.classes.map((c) => [c.id, c.pattern as string]));
    for (let i = 0; i < samples.length; i++) {
      const s = samples[i]!;
      const x0 = x(s.ts);
      const x1 = x(samples[i + 1]?.ts ?? s.ts + 1000);
      const cw = Math.max(1, x1 - x0 + 0.5);
      const colour = s.known ? (p.conditions[s.label] ?? p.unknown) : p.unknown;
      ctx.globalAlpha = s.lowConfidence ? 0.4 : 1;
      const pattern = patternOf.get(s.label) ?? 'solid';
      if (pattern === 'hollow') {
        ctx.strokeStyle = colour;
        ctx.lineWidth = 1.5;
        ctx.strokeRect(x0 + 0.75, stripTop + 0.75, cw - 1.5, L.stripH - 1.5);
      } else if (pattern === 'hatched') {
        ctx.fillStyle = colour;
        ctx.fillRect(x0, stripTop, cw, L.stripH);
        ctx.fillStyle = p.halo;
        ctx.globalAlpha *= 0.5;
        for (let yy = stripTop + 2; yy < stripTop + L.stripH; yy += 4)
          ctx.fillRect(x0, yy, cw, 1.2);
      } else {
        ctx.fillStyle = colour;
        ctx.fillRect(x0, stripTop, cw, L.stripH);
      }
    }
    ctx.globalAlpha = 1;
    // Bump pins above the strip.
    for (const b of d.bumps) {
      const bx = x(b.ts);
      ctx.fillStyle = p.conditions.bump ?? p.unknown;
      ctx.beginPath();
      ctx.moveTo(bx, stripTop - 1);
      ctx.lineTo(bx - 4, stripTop - 8);
      ctx.lineTo(bx + 4, stripTop - 8);
      ctx.closePath();
      ctx.fill();
    }

    // Time axis (mm:ss from ride start).
    const totalS = span / 1000;
    const stepS = [15, 30, 60, 120, 300, 600, 900, 1800].find((s) => totalS / s <= 10) ?? 1800;
    ctx.font = `9px ${p.fontMono}`;
    ctx.fillStyle = p.ink3;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    const firstS = Math.ceil((r.start - d.firstTs) / 1000 / stepS) * stepS;
    for (let s = firstS; s <= (r.end - d.firstTs) / 1000; s += stepS) {
      const px = x(d.firstTs + s * 1000);
      ctx.fillRect(px, axisY - 3, 1, 3);
      ctx.fillText(formatClock(s), px, axisY);
    }

    // Playhead (scrub position).
    const view = this.store.viewTs;
    if (view != null) {
      const px = x(view);
      ctx.fillStyle = withAlpha(p.ink, 0.08);
      ctx.fillRect(px, L.top, L.left + plotW - px, axisY - L.top);
      ctx.strokeStyle = p.ink;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(px, L.top - 2);
      ctx.lineTo(px, axisY);
      ctx.stroke();
      ctx.fillStyle = p.ink;
      ctx.beginPath();
      ctx.moveTo(px - 5, L.top - 2);
      ctx.lineTo(px + 5, L.top - 2);
      ctx.lineTo(px, L.top + 5);
      ctx.closePath();
      ctx.fill();
    }

    // Hover crosshair.
    if (this.hoverX != null && this.hoverTs != null) {
      const px = clamp(this.hoverX, L.left, L.left + plotW);
      ctx.strokeStyle = p.ink2;
      ctx.setLineDash([3, 3]);
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(px + 0.5, L.top);
      ctx.lineTo(px + 0.5, axisY);
      ctx.stroke();
      ctx.setLineDash([]);
      const s = this.store.sampleAt(d, this.hoverTs);
      if (s) {
        const py = vibTop + L.vibH - (clamp(s.vib, 0, vmax) / vmax) * L.vibH;
        ctx.fillStyle = p.accent;
        ctx.beginPath();
        ctx.arc(px, py, 3, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }

  /** Marks a sample's time from an external hover (map hover). */
  externalHover(sample: Sample | null): void {
    if (!sample) {
      this.hoverX = null;
      this.hoverTs = null;
    } else {
      this.hoverTs = sample.ts;
      this.hoverX = this.xAt(sample.ts);
    }
    this.needsDraw = true;
  }

  deviceFor(): DeviceState | null {
    return this.store.selected;
  }
}

/**
 * The right-hand rail: current condition with its confidence ring, class
 * probabilities, the cyclist scene, live readings, the ride summary with the
 * comfort score, and small multiples for the other bikes.
 */
import type { AppConfig } from '../config/types';
import type { DeviceState, RideStore, Sample } from '../data/store';
import { el, prefersReducedMotion } from '../utils/dom';
import {
  formatAge,
  formatClock,
  formatDistance,
  formatFixed,
  formatSpeed,
  speedUnitLabel,
} from '../utils/format';
import { Cyclist } from './cyclist';
import type { ThemeManager } from './theme';

/** A text node that animates briefly when its value changes, without blurring digits. */
class Roller {
  readonly node: HTMLElement;
  private value = '';
  private lastChange = 0;

  constructor(cls = 'roller t-num') {
    this.node = el('span', { class: cls });
  }

  set(text: string, now = performance.now()): void {
    if (text === this.value) return;
    // At most four changes per second so the digits stay legible.
    if (now - this.lastChange < 240 && this.value !== '') return;
    this.value = text;
    this.lastChange = now;
    this.node.textContent = text;
    this.node.classList.remove('is-ticking');
    void this.node.offsetWidth;
    this.node.classList.add('is-ticking');
  }

  force(text: string): void {
    this.value = text;
    this.node.textContent = text;
  }
}

interface Reading {
  key: string;
  label: string;
  unit: string;
  roller: Roller;
  unitNode: HTMLElement;
}

export class Rail {
  private cfg: AppConfig;
  private condLabel: HTMLElement;
  private condHint: HTMLElement;
  private condRaw: HTMLElement;
  private ring: SVGCircleElement;
  private ringText: Roller;
  private probs: HTMLElement;
  private probBars = new Map<string, { bar: HTMLElement; value: HTMLElement }>();
  private readings: Reading[] = [];
  private summary = new Map<string, Roller>();
  private comfortNode: HTMLElement;
  private comfortBar: HTMLElement;
  private cyclist: Cyclist;
  private multiples = new Map<string, { cyclist: Cyclist; wrap: HTMLElement }>();
  private multiplesWrap: HTMLElement;
  private sourceNote: HTMLElement;
  private lastSample: Sample | null = null;
  private lastDeviceId: string | null = null;
  private lastTick = 0;
  readonly elevationSection: HTMLElement;
  private elevationCanvas: HTMLCanvasElement;
  private lastElevation = 0;

  constructor(
    private readonly root: HTMLElement,
    private readonly store: RideStore,
    private readonly theme: ThemeManager,
    cfg: AppConfig,
  ) {
    this.cfg = cfg;

    // --- current condition
    this.condLabel = el('div', { class: 'cond-label t-display' });
    this.condHint = el('div', { class: 'cond-hint' });
    this.condRaw = el('div', { class: 'cond-raw t-num', hidden: true });
    this.ringText = new Roller('ring-text t-num');
    const ringSvg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    ringSvg.setAttribute('viewBox', '0 0 44 44');
    ringSvg.setAttribute('class', 'ring');
    const track = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    track.setAttribute('class', 'ring-track');
    track.setAttribute('cx', '22');
    track.setAttribute('cy', '22');
    track.setAttribute('r', '19');
    this.ring = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    this.ring.setAttribute('class', 'ring-value');
    this.ring.setAttribute('cx', '22');
    this.ring.setAttribute('cy', '22');
    this.ring.setAttribute('r', '19');
    ringSvg.append(track, this.ring);
    const ringWrap = el(
      'div',
      { class: 'ring-wrap', title: 'Confidence of the current classification' },
      [ringSvg, this.ringText.node],
    );
    this.probs = el('div', { class: 'probs' });
    this.sourceNote = el('div', { class: 'source-note t-label' });
    const condSection = el('section', { class: 'rail-section cond-section' }, [
      el('div', { class: 'rail-head' }, [
        el('span', { class: 't-label', text: 'Current condition' }),
        this.sourceNote,
      ]),
      el('div', { class: 'cond-row' }, [
        el('div', { class: 'cond-main' }, [this.condLabel, this.condHint, this.condRaw]),
        ringWrap,
      ]),
      this.probs,
    ]);

    // --- cyclist
    const sceneWrap = el('section', { class: 'rail-section scene-section' });
    this.cyclist = new Cyclist(sceneWrap);
    this.cyclist.setReduced(prefersReducedMotion() || theme.motionScale === 0);

    // --- readings
    const grid = el('div', { class: 'readings' });
    const defs: [string, string, string][] = [
      ['speed', 'Speed', speedUnitLabel(cfg.units.speed)],
      ['vib', 'Vibration', 'm/s²'],
      ['bpk', 'Bumps per km', ''],
      ['age', 'Last message', 'ago'],
      ['rate', 'Message rate', 'per s'],
      ['lost', 'Lost', 'msgs'],
      ['inference', 'Model run time', 'ms'],
      ['latency', 'Latency', 'ms'],
    ];
    for (const [key, label, unit] of defs) {
      const roller = new Roller('reading-value t-num');
      const unitNode = el('span', { class: 'reading-unit', text: unit });
      grid.append(
        el('div', { class: 'reading', 'data-key': key }, [
          el('span', { class: 't-label', text: label }),
          el('div', { class: 'reading-row' }, [roller.node, unitNode]),
        ]),
      );
      this.readings.push({ key, label, unit, roller, unitNode });
    }
    const readingsSection = el('section', { class: 'rail-section' }, [
      el('div', { class: 'rail-head' }, [el('span', { class: 't-label', text: 'Live readings' })]),
      grid,
    ]);

    // --- summary
    const sumGrid = el('div', { class: 'summary' });
    const sumDefs: [string, string][] = [
      ['distance', 'Distance'],
      ['moving', 'Moving time'],
      ['avg', 'Average speed'],
      ['max', 'Maximum speed'],
      ['stops', 'Stops'],
      ['bumps', 'Bumps'],
      ['rough', 'Rough road'],
    ];
    for (const [key, label] of sumDefs) {
      const roller = new Roller('summary-value t-num');
      this.summary.set(key, roller);
      sumGrid.append(
        el('div', { class: 'summary-item' }, [
          el('span', { class: 't-label', text: label }),
          roller.node,
        ]),
      );
    }
    this.comfortNode = el('div', { class: 'comfort-value t-display', text: '--' });
    this.comfortBar = el('div', { class: 'comfort-bar-fill' });
    const comfort = el('div', { class: 'comfort', title: store.comfortFormula() }, [
      el('div', { class: 'comfort-head' }, [
        el('span', { class: 't-label', text: 'Comfort score' }),
        el('span', { class: 't-label comfort-scale', text: '0 to 100' }),
      ]),
      el('div', { class: 'comfort-row' }, [
        this.comfortNode,
        el('div', { class: 'comfort-bar' }, [this.comfortBar]),
      ]),
    ]);
    this.elevationCanvas = el('canvas', { class: 'elevation-canvas' });
    this.elevationSection = el('div', { class: 'elevation', hidden: true }, [
      el('span', { class: 't-label', text: 'Elevation (from GPS altitude)' }),
      this.elevationCanvas,
    ]);
    const summarySection = el('section', { class: 'rail-section is-secondary' }, [
      el('div', { class: 'rail-head' }, [el('span', { class: 't-label', text: 'Ride summary' })]),
      sumGrid,
      comfort,
      this.elevationSection,
    ]);

    // --- other bikes
    this.multiplesWrap = el('div', { class: 'multiples' });
    const multiplesSection = el(
      'section',
      { class: 'rail-section multiples-section is-secondary', hidden: true },
      [
        el('div', { class: 'rail-head' }, [el('span', { class: 't-label', text: 'Other bikes' })]),
        this.multiplesWrap,
      ],
    );

    root.append(condSection, sceneWrap, readingsSection, summarySection, multiplesSection);
    this.buildProbBars();
    this.applyPalette();

    theme.on('change', () => {
      this.applyPalette();
      this.cyclist.setReduced(prefersReducedMotion() || theme.motionScale === 0);
      for (const m of this.multiples.values())
        m.cyclist.setReduced(prefersReducedMotion() || theme.motionScale === 0);
    });
    store.on('bump', ({ device }) => {
      if (device.id === store.selectedId && store.isLive) this.cyclist.bump();
      else this.multiples.get(device.id)?.cyclist.bump();
    });
    store.on('reset', () => this.clearMultiples());
    store.on('device-added', () => this.syncMultiples());
    store.on('device-selected', () => this.syncMultiples());
  }

  setConfig(cfg: AppConfig): void {
    this.cfg = cfg;
    const speed = this.readings.find((r) => r.key === 'speed');
    if (speed) speed.unitNode.textContent = speedUnitLabel(cfg.units.speed);
    this.buildProbBars();
    this.root
      .querySelector<HTMLElement>('.comfort')
      ?.setAttribute('title', this.store.comfortFormula());
  }

  private applyPalette(): void {
    const p = this.theme.palette;
    const pal = {
      ink: p.ink,
      ink3: p.ink3,
      surface: p.surface,
      line: p.line,
      halo: p.halo,
      bg: p.bg,
    };
    this.cyclist.setPalette(pal);
    for (const m of this.multiples.values()) m.cyclist.setPalette(pal);
  }

  private buildProbBars(): void {
    this.probs.replaceChildren();
    this.probBars.clear();
    for (const c of this.cfg.classes) {
      const bar = el('div', { class: 'prob-bar-fill' });
      const value = el('span', { class: 'prob-value t-num', text: '--' });
      const row = el('div', { class: 'prob-row', 'data-label': c.id }, [
        el('span', { class: 'prob-name', text: c.name }),
        el('div', { class: 'prob-bar' }, [bar]),
        value,
      ]);
      row.style.setProperty('--c', `var(--cond-${c.id})`);
      this.probs.append(row);
      this.probBars.set(c.id, { bar, value });
    }
  }

  private syncMultiples(): void {
    const section = this.multiplesWrap.parentElement!;
    const others = this.store.deviceList.filter((d) => d.id !== this.store.selectedId);
    for (const [id, m] of this.multiples) {
      if (!others.some((d) => d.id === id)) {
        m.wrap.remove();
        this.multiples.delete(id);
      }
    }
    for (const d of others) {
      if (this.multiples.has(d.id)) continue;
      const wrap = el('button', { class: 'multiple', type: 'button', title: `Select ${d.id}` });
      wrap.style.setProperty('--bike', `var(--bike-${d.slot})`);
      wrap.addEventListener('click', () => this.store.select(d.id));
      const cyclist = new Cyclist(wrap, true);
      cyclist.setReduced(prefersReducedMotion() || this.theme.motionScale === 0);
      const p = this.theme.palette;
      cyclist.setPalette({
        ink: p.ink,
        ink3: p.ink3,
        surface: p.surface,
        line: p.line,
        halo: p.halo,
        bg: p.bg,
      });
      wrap.append(el('div', { class: 'multiple-stats t-num' }));
      this.multiplesWrap.append(wrap);
      this.multiples.set(d.id, { cyclist, wrap });
    }
    section.hidden = others.length === 0;
  }

  private clearMultiples(): void {
    for (const m of this.multiples.values()) m.wrap.remove();
    this.multiples.clear();
    this.multiplesWrap.parentElement!.hidden = true;
  }

  /** Called every animation frame. */
  frame(now: number, dt: number): void {
    const d = this.store.selected;
    const t = this.store.viewTs;
    const sample = d ? this.store.sampleAt(d, t) : null;
    const p = this.theme.palette;

    if (d && sample) {
      if (sample !== this.lastSample || d.id !== this.lastDeviceId) {
        this.lastSample = sample;
        this.lastDeviceId = d.id;
        this.renderCondition(d, sample, now);
      }
      const pos = this.store.positionAt(d, t);
      const speed = pos?.speed ?? sample.speed ?? 0;
      this.cyclist.setState({
        label: sample.label,
        speed,
        vib: sample.vib,
        colour: p.bikes[(d.slot - 1) % 4] ?? p.accent,
        conditionColour: p.conditions[sample.label] ?? p.unknown,
        name: d.id,
      });
    }
    this.cyclist.frame(now, dt);

    for (const [id, m] of this.multiples) {
      const dev = this.store.devices.get(id);
      if (!dev) continue;
      const s = this.store.sampleAt(dev, t);
      const pos = this.store.positionAt(dev, t);
      if (s) {
        m.cyclist.setState({
          label: s.label,
          speed: pos?.speed ?? s.speed ?? 0,
          vib: s.vib,
          colour: p.bikes[(dev.slot - 1) % 4] ?? p.accent,
          conditionColour: p.conditions[s.label] ?? p.unknown,
          name: dev.id,
        });
      }
      m.cyclist.frame(now, dt);
      const stats = m.wrap.querySelector('.multiple-stats');
      if (stats && now - this.lastTick > 500) {
        stats.textContent = `${formatDistance(dev.stats.distanceM)}  ${dev.stats.bumps} bumps  ${dev.stats.comfort == null ? '--' : Math.round(dev.stats.comfort)}`;
      }
    }

    // Readings and summary at 4 Hz.
    if (now - this.lastTick > 250) {
      this.lastTick = now;
      if (d) this.renderNumbers(d, sample, now);
    }
  }

  private renderCondition(d: DeviceState, s: Sample, now: number): void {
    const cls = this.cfg.classes.find((c) => c.id === s.label);
    this.condLabel.textContent = cls?.name ?? s.rawLabel;
    this.condLabel.style.setProperty(
      '--c',
      s.known ? `var(--cond-${s.label})` : 'var(--cond-unknown)',
    );
    this.condLabel.classList.toggle('is-low', s.lowConfidence);
    this.condHint.textContent = s.known
      ? (cls?.hint ?? '')
      : 'Label not in the class list: add an alias in settings';
    this.condRaw.hidden = s.known;
    this.condRaw.textContent = s.known ? '' : `raw label: ${s.rawLabel}`;
    const circ = 2 * Math.PI * 19;
    this.ring.style.strokeDasharray = `${circ}`;
    this.ring.style.strokeDashoffset = `${circ * (1 - s.confidence)}`;
    this.ring.style.stroke = s.known ? `var(--cond-${s.label})` : 'var(--cond-unknown)';
    this.ringText.set(`${Math.round(s.confidence * 100)}%`, now);
    const hasScores = !!s.scores;
    this.probs.classList.toggle('is-empty', !hasScores);
    for (const [id, bar] of this.probBars) {
      const v = s.scores?.[id];
      bar.bar.style.width = v == null ? '0%' : `${Math.round(v * 100)}%`;
      bar.value.textContent = v == null ? (hasScores ? '0%' : '--') : `${Math.round(v * 100)}%`;
      bar.bar.parentElement!.parentElement!.classList.toggle('is-top', id === s.label);
    }
    this.sourceNote.textContent = this.store.isLive
      ? d.id
      : `${d.id} at ${formatClock((s.ts - d.firstTs) / 1000)}`;
  }

  /** Small elevation profile, only when the GPS source reports altitude. */
  private drawElevation(d: DeviceState): void {
    const c = this.elevationCanvas;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = c.clientWidth;
    const h = c.clientHeight;
    if (!w || !h) return;
    c.width = Math.round(w * dpr);
    c.height = Math.round(h * dpr);
    const ctx = c.getContext('2d')!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    const fixes = d.gps.all().filter((f) => f.alt != null);
    if (fixes.length < 2) return;
    const alts = fixes.map((f) => f.alt!);
    const min = Math.min(...alts);
    const max = Math.max(...alts, min + 5);
    const p = this.theme.palette;
    ctx.beginPath();
    ctx.moveTo(0, h);
    fixes.forEach((f, i) =>
      ctx.lineTo((i / (fixes.length - 1)) * w, h - ((f.alt! - min) / (max - min)) * (h - 12) - 2),
    );
    ctx.lineTo(w, h);
    ctx.closePath();
    ctx.fillStyle = `${p.accent}33`;
    ctx.fill();
    ctx.strokeStyle = p.accent;
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    fixes.forEach((f, i) => {
      const x = (i / (fixes.length - 1)) * w;
      const y = h - ((f.alt! - min) / (max - min)) * (h - 12) - 2;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.stroke();
    ctx.fillStyle = p.ink3;
    ctx.font = `9px ${p.fontMono}`;
    ctx.textAlign = 'right';
    ctx.fillText(`${max.toFixed(0)} m`, w - 2, 10);
    ctx.fillText(`${min.toFixed(0)} m`, w - 2, h - 3);
  }

  private renderNumbers(d: DeviceState, s: Sample | null, now: number): void {
    const st = d.stats;
    const live = this.store.isLive;
    const pos = this.store.positionAt(d, this.store.viewTs);
    const set = (key: string, v: string) =>
      this.readings.find((r) => r.key === key)?.roller.set(v, now);
    set('speed', formatSpeed(pos?.speed ?? s?.speed ?? null, this.cfg.units.speed));
    set('vib', s ? formatFixed(s.vib, 1) : '--');
    set('bpk', formatFixed(st.bumpsPerKm, 1));
    set('age', live ? formatAge(Date.now() - d.lastConditionAt) : '--');
    const ageReading = this.readings.find((r) => r.key === 'age');
    if (ageReading) ageReading.unitNode.textContent = live ? 'ago' : 'scrubbing';
    set('rate', formatFixed(st.rateHz, 1));
    set('lost', String(st.lost));
    set('inference', s?.inferenceMs != null ? formatFixed(s.inferenceMs, 1) : '--');
    set('latency', live && st.lastLatencyMs != null ? String(Math.round(st.lastLatencyMs)) : '--');
    const vibReading = this.readings.find((r) => r.key === 'vib');
    if (vibReading)
      vibReading.unitNode.textContent = s?.vibMeasured === false ? 'm/s² est.' : 'm/s²';

    this.summary.get('distance')?.set(formatDistance(st.distanceM), now);
    this.summary.get('moving')?.set(formatClock(st.movingTimeMs / 1000), now);
    this.summary
      .get('avg')
      ?.set(
        `${formatSpeed(st.avgSpeed, this.cfg.units.speed)} ${speedUnitLabel(this.cfg.units.speed)}`,
        now,
      );
    this.summary
      .get('max')
      ?.set(
        `${formatSpeed(st.maxSpeed, this.cfg.units.speed)} ${speedUnitLabel(this.cfg.units.speed)}`,
        now,
      );
    this.summary.get('stops')?.set(String(st.stops), now);
    this.summary.get('bumps')?.set(String(st.bumps), now);
    this.summary.get('rough')?.set(formatDistance(st.roughM), now);
    if (st.hasElevation && now - this.lastElevation > 2000) {
      this.lastElevation = now;
      this.elevationSection.hidden = false;
      this.drawElevation(d);
    } else if (!st.hasElevation) this.elevationSection.hidden = true;
    const comfort = st.comfort == null ? null : Math.round(st.comfort);
    this.comfortNode.textContent = comfort == null ? '--' : String(comfort);
    this.comfortBar.style.width = `${comfort ?? 0}%`;
    this.comfortBar.style.background =
      comfort == null
        ? 'var(--line)'
        : comfort >= 70
          ? 'var(--cond-smooth)'
          : comfort >= 40
            ? 'var(--cond-rough)'
            : 'var(--cond-bump)';
  }
}

/**
 * The animated cyclist: an original side-view illustration built from simple
 * geometric shapes. Wheels and pedals turn with the live speed, the frame
 * shakes on rough road in proportion to the vibration, a bump compresses
 * and rebounds with a spring curve, and when stopped the rider puts a foot
 * down. A road strip scrolls under the wheels showing the surface, with a
 * faint parallax skyline behind.
 *
 * With reduced motion the scene is replaced by a static icon and a text state.
 */
import { el, svgEl } from '../utils/dom';
import { clamp } from '../utils/format';

export interface CyclistState {
  label: string;
  /** km/h */
  speed: number;
  /** m/s^2 */
  vib: number;
  colour: string;
  conditionColour: string;
  name: string;
}

interface Tape {
  label: string;
  /** x position in metres along the tape (world units). */
  from: number;
  to: number;
}

const W = 320;
const H = 190;
const GROUND = 160;
const WHEEL_R = 32;
const REAR: [number, number] = [78, GROUND - WHEEL_R];
const FRONT: [number, number] = [238, GROUND - WHEEL_R];
const BB: [number, number] = [150, GROUND - 26];
const CRANK = 17;
const HIP: [number, number] = [124, 76];
const PX_PER_M = 44;

export class Cyclist {
  readonly root: HTMLElement;
  private svg: SVGSVGElement;
  private body: SVGGElement;
  private rider: SVGGElement;
  private wheels: SVGGElement[] = [];
  private crank!: SVGGElement;
  private legNear!: { upper: SVGLineElement; lower: SVGLineElement; foot: SVGCircleElement };
  private legFar!: { upper: SVGLineElement; lower: SVGLineElement; foot: SVGCircleElement };
  private impact!: SVGEllipseElement;
  private stateText: HTMLElement;
  private road: HTMLCanvasElement;
  private sky: HTMLCanvasElement;
  private roadCtx: CanvasRenderingContext2D;
  private skyCtx: CanvasRenderingContext2D;

  private state: CyclistState = {
    label: 'smooth',
    speed: 0,
    vib: 0,
    colour: '#1f6fe0',
    conditionColour: '#118a6a',
    name: '',
  };
  private shownSpeed = 0;
  private wheelAngle = 0;
  private crankAngle = 0;
  private shake: [number, number] = [0, 0];
  private bumpAt = -1;
  private distance = 0;
  private tape: Tape[] = [];
  private tapeHead = 0;
  private bumps: number[] = [];
  private footDown = 0;
  private reduced = false;
  private palette = {
    ink: '#111',
    ink3: '#777',
    surface: '#fff',
    line: '#ccc',
    halo: '#fff',
    bg: '#eee',
  };
  private buildings: { x: number; w: number; h: number }[] = [];

  constructor(
    container: HTMLElement,
    private readonly compact = false,
  ) {
    this.root = el('div', { class: `cyclist ${compact ? 'is-compact' : ''}`, role: 'img' });
    this.sky = el('canvas', { class: 'cyclist-sky' });
    this.road = el('canvas', { class: 'cyclist-road' });
    this.svg = svgEl('svg', {
      viewBox: `0 0 ${W} ${H}`,
      class: 'cyclist-svg',
      'aria-hidden': 'true',
    });
    this.stateText = el('div', { class: 'cyclist-state t-label' });
    this.body = svgEl('g', { class: 'cyclist-body' });
    this.rider = svgEl('g', { class: 'cyclist-rider' });
    this.build();
    this.root.append(this.sky, this.svg, this.road, this.stateText);
    container.append(this.root);
    this.roadCtx = this.road.getContext('2d')!;
    this.skyCtx = this.sky.getContext('2d')!;
    // A skyline of a few blocks, lamp posts and trees, repeating every 1200 px.
    let x = 0;
    while (x < 1200) {
      const w = 40 + Math.random() * 70;
      this.buildings.push({ x, w, h: 22 + Math.random() * 46 });
      x += w + 10 + Math.random() * 30;
    }
    this.tape.push({ label: 'smooth', from: -20, to: 40 });
    this.tapeHead = 40;
  }

  setPalette(p: {
    ink: string;
    ink3: string;
    surface: string;
    line: string;
    halo: string;
    bg: string;
  }): void {
    this.palette = p;
  }

  setReduced(on: boolean): void {
    this.reduced = on;
    this.root.classList.toggle('is-reduced', on);
  }

  setState(s: Partial<CyclistState>): void {
    const prevLabel = this.state.label;
    Object.assign(this.state, s);
    this.root.style.setProperty('--bike', this.state.colour);
    this.root.style.setProperty('--cond', this.state.conditionColour);
    this.root.dataset.label = this.state.label;
    if (this.state.label !== prevLabel) this.extendTape(this.state.label, true);
    const speedText = `${this.state.speed.toFixed(0)} km/h`;
    this.stateText.textContent = this.compact
      ? `${this.state.name} ${this.state.label}`
      : `${this.state.label} ${speedText}`;
  }

  /** Triggers the single-jolt animation. */
  bump(): void {
    this.bumpAt = performance.now();
    this.bumps.push(this.tapeHead + 1.2);
  }

  private extendTape(label: string, force = false): void {
    const last = this.tape[this.tape.length - 1];
    if (last && last.label === label && !force) {
      last.to = this.tapeHead + 12;
      return;
    }
    if (last) last.to = this.tapeHead + 1.5;
    this.tape.push({ label, from: this.tapeHead + 1.5, to: this.tapeHead + 14 });
    if (this.tape.length > 40) this.tape.shift();
  }

  private build(): void {
    const s = this.svg;
    const stroke = (extra: Record<string, string | number> = {}) => ({
      fill: 'none',
      'stroke-width': 4,
      'stroke-linecap': 'round',
      'stroke-linejoin': 'round',
      ...extra,
    });
    // Impact mark under the front wheel.
    this.impact = svgEl('ellipse', {
      cx: FRONT[0],
      cy: GROUND + 3,
      rx: 0,
      ry: 0,
      class: 'cyclist-impact',
    });
    s.append(this.impact);

    // Wheels: rim, tyre, spokes, hub.
    for (const [cx, cy] of [REAR, FRONT]) {
      const g = svgEl('g', { class: 'cyclist-wheel', transform: `translate(${cx} ${cy})` });
      g.append(
        svgEl('circle', { r: WHEEL_R, class: 'cyclist-tyre', ...stroke({ 'stroke-width': 5 }) }),
      );
      g.append(
        svgEl('circle', {
          r: WHEEL_R - 6,
          class: 'cyclist-rim',
          ...stroke({ 'stroke-width': 1.5 }),
        }),
      );
      for (let i = 0; i < 6; i++) {
        const a = (i / 6) * Math.PI * 2;
        g.append(
          svgEl('line', {
            x1: 0,
            y1: 0,
            x2: Math.cos(a) * (WHEEL_R - 6),
            y2: Math.sin(a) * (WHEEL_R - 6),
            class: 'cyclist-spoke',
            ...stroke({ 'stroke-width': 1.5 }),
          }),
        );
      }
      g.append(svgEl('circle', { r: 4, class: 'cyclist-hub' }));
      this.wheels.push(g);
      this.body.append(g);
    }

    // Frame: a diamond drawn as one path, plus fork and seat post.
    const saddle: [number, number] = [126, 86];
    const head: [number, number] = [214, 92];
    const frame = svgEl('path', {
      d: `M${REAR[0]} ${REAR[1]} L${BB[0]} ${BB[1]} L${head[0]} ${head[1]} L${saddle[0]} ${saddle[1]} Z M${REAR[0]} ${REAR[1]} L${saddle[0]} ${saddle[1]} M${head[0]} ${head[1]} L${FRONT[0]} ${FRONT[1]} M${saddle[0]} ${saddle[1]} L${HIP[0]} ${HIP[1] + 4} M${head[0]} ${head[1]} L${220} ${74} L${232} ${72}`,
      class: 'cyclist-frame',
      ...stroke({ 'stroke-width': 4.5 }),
    });
    this.body.append(frame);
    // Saddle.
    this.body.append(
      svgEl('path', {
        d: `M${HIP[0] - 10} ${HIP[1] + 4} L${HIP[0] + 8} ${HIP[1] + 4}`,
        class: 'cyclist-saddle',
        ...stroke({ 'stroke-width': 6 }),
      }),
    );

    // Far leg (behind the frame).
    this.legFar = this.makeLeg('cyclist-leg-far');
    this.body.append(this.legFar.upper, this.legFar.lower, this.legFar.foot);

    // Crank and pedals.
    this.crank = svgEl('g', { transform: `translate(${BB[0]} ${BB[1]})` });
    this.crank.append(
      svgEl('line', {
        x1: -CRANK,
        y1: 0,
        x2: CRANK,
        y2: 0,
        class: 'cyclist-crank',
        ...stroke({ 'stroke-width': 3.5 }),
      }),
    );
    this.crank.append(
      svgEl('circle', { r: 7, class: 'cyclist-chainring', ...stroke({ 'stroke-width': 2.5 }) }),
    );
    this.body.append(this.crank);

    // Rider: torso, head, arm.
    const shoulder: [number, number] = [176, 44];
    this.rider.append(
      svgEl('line', {
        x1: HIP[0],
        y1: HIP[1],
        x2: shoulder[0],
        y2: shoulder[1],
        class: 'cyclist-torso',
        ...stroke({ 'stroke-width': 11 }),
      }),
    );
    this.rider.append(
      svgEl('line', {
        x1: shoulder[0],
        y1: shoulder[1],
        x2: 226,
        y2: 72,
        class: 'cyclist-arm',
        ...stroke({ 'stroke-width': 6 }),
      }),
    );
    this.rider.append(svgEl('circle', { cx: 194, cy: 30, r: 11, class: 'cyclist-head' }));
    this.rider.append(
      svgEl('path', {
        d: 'M183 27 Q194 14 207 27',
        class: 'cyclist-helmet',
        ...stroke({ 'stroke-width': 5 }),
      }),
    );
    this.body.append(this.rider);

    // Near leg (in front).
    this.legNear = this.makeLeg('cyclist-leg-near');
    this.body.append(this.legNear.upper, this.legNear.lower, this.legNear.foot);

    s.append(this.body);
  }

  private makeLeg(cls: string): {
    upper: SVGLineElement;
    lower: SVGLineElement;
    foot: SVGCircleElement;
  } {
    const attrs = { fill: 'none', 'stroke-width': 7, 'stroke-linecap': 'round' };
    return {
      upper: svgEl('line', { class: `cyclist-leg ${cls}`, ...attrs }),
      lower: svgEl('line', { class: `cyclist-leg ${cls}`, ...attrs }),
      foot: svgEl('circle', { r: 4, class: `cyclist-foot ${cls}` }),
    };
  }

  /** Two-segment inverse kinematics from the hip to a foot position. */
  private poseLeg(
    leg: { upper: SVGLineElement; lower: SVGLineElement; foot: SVGCircleElement },
    foot: [number, number],
  ): void {
    const L = 46;
    const dx = foot[0] - HIP[0];
    const dy = foot[1] - HIP[1];
    const d = clamp(Math.hypot(dx, dy), 4, 2 * L - 0.5);
    const a = Math.atan2(dy, dx);
    const b = Math.acos(d / (2 * L));
    // Knee bends forward (towards the handlebar).
    const ka = a - b;
    const knee: [number, number] = [HIP[0] + Math.cos(ka) * L, HIP[1] + Math.sin(ka) * L];
    leg.upper.setAttribute('x1', String(HIP[0]));
    leg.upper.setAttribute('y1', String(HIP[1]));
    leg.upper.setAttribute('x2', String(knee[0]));
    leg.upper.setAttribute('y2', String(knee[1]));
    leg.lower.setAttribute('x1', String(knee[0]));
    leg.lower.setAttribute('y1', String(knee[1]));
    leg.lower.setAttribute('x2', String(foot[0]));
    leg.lower.setAttribute('y2', String(foot[1]));
    leg.foot.setAttribute('cx', String(foot[0]));
    leg.foot.setAttribute('cy', String(foot[1]));
  }

  /** Advances the animation. dt in seconds. */
  frame(now: number, dt: number): void {
    if (this.reduced) return;
    const s = this.state;
    // Ease the displayed speed so changes read as acceleration, not jumps.
    this.shownSpeed += (s.speed - this.shownSpeed) * clamp(dt * 2.5, 0, 1);
    const ms = this.shownSpeed / 3.6;
    this.distance += ms * dt;
    this.tapeHead = this.distance + 8;
    this.extendTape(s.label);

    // Wheels: angular velocity = v / r (r about 0.34 m).
    this.wheelAngle = (this.wheelAngle + (ms / 0.34) * dt * (180 / Math.PI)) % 360;
    for (const w of this.wheels) {
      const t = w.getAttribute('transform') ?? '';
      const base = t.split(' rotate')[0];
      w.setAttribute('transform', `${base} rotate(${this.wheelAngle})`);
    }
    // Cadence: about 70 rpm at 16 km/h, falling to zero when stopped.
    const rpm = ms > 0.2 ? clamp(this.shownSpeed * 4.4, 30, 95) : 0;
    this.crankAngle = (this.crankAngle + rpm * 6 * dt) % 360;
    this.crank.setAttribute('transform', `translate(${BB[0]} ${BB[1]}) rotate(${this.crankAngle})`);

    // Foot down when stopped.
    // Foot down only when the bike really is (nearly) still; a lone "stopped"
    // label at speed is a classifier mistake and should not stop the wheels.
    const stopped = (s.label === 'stopped' && this.shownSpeed < 4) || this.shownSpeed < 0.8;
    this.footDown += ((stopped ? 1 : 0) - this.footDown) * clamp(dt * 4, 0, 1);
    const ca = (this.crankAngle * Math.PI) / 180;
    const pedalNear: [number, number] = [
      BB[0] + Math.cos(ca) * CRANK,
      BB[1] + Math.sin(ca) * CRANK,
    ];
    const pedalFar: [number, number] = [BB[0] - Math.cos(ca) * CRANK, BB[1] - Math.sin(ca) * CRANK];
    const groundFoot: [number, number] = [BB[0] + 18, GROUND - 2];
    const nearFoot: [number, number] = [
      pedalNear[0] + (groundFoot[0] - pedalNear[0]) * this.footDown,
      pedalNear[1] + (groundFoot[1] - pedalNear[1]) * this.footDown,
    ];
    this.poseLeg(this.legNear, nearFoot);
    this.poseLeg(this.legFar, pedalFar);

    // Rough road: a fine continuous shake whose amplitude follows the vibration.
    const amp = stopped ? 0 : clamp(s.vib * 0.32, 0, 3.2);
    this.shake = [
      this.shake[0] * 0.5 + (Math.random() - 0.5) * amp,
      this.shake[1] * 0.5 + (Math.random() - 0.5) * amp * 1.4,
    ];

    // Bump: compress and rebound with a damped spring over about 0.8 s.
    let bumpY = 0;
    let impactR = 0;
    if (this.bumpAt > 0) {
      const t = (now - this.bumpAt) / 1000;
      if (t < 0.9) {
        bumpY = 9 * Math.exp(-5 * t) * Math.sin(2 * Math.PI * 2.4 * t);
        impactR = t < 0.35 ? (t / 0.35) * 16 : Math.max(0, 16 - ((t - 0.35) / 0.55) * 16);
      } else this.bumpAt = -1;
    }
    impactR = Math.max(0, impactR);
    this.impact.setAttribute('rx', String(impactR));
    this.impact.setAttribute('ry', String(impactR * 0.28));
    this.impact.setAttribute('opacity', String(impactR > 0 ? 0.5 : 0));
    this.body.setAttribute(
      'transform',
      `translate(${this.shake[0].toFixed(2)} ${(this.shake[1] + bumpY).toFixed(2)})`,
    );
    // The rider lags a little behind the frame on a bump.
    this.rider.setAttribute('transform', `translate(0 ${(bumpY * 0.6).toFixed(2)})`);

    this.drawRoad();
    if (!this.compact) this.drawSky();
  }

  private sizeCanvas(c: HTMLCanvasElement): boolean {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = Math.round(c.clientWidth * dpr);
    const h = Math.round(c.clientHeight * dpr);
    if (!w || !h) return false;
    if (c.width !== w || c.height !== h) {
      c.width = w;
      c.height = h;
    }
    return true;
  }

  /** The road under the wheels: texture by surface, scrolling at the live speed. */
  private drawRoad(): void {
    if (!this.sizeCanvas(this.road)) return;
    const ctx = this.roadCtx;
    const dpr = this.road.width / this.road.clientWidth;
    const w = this.road.clientWidth;
    const h = this.road.clientHeight;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    const scale = (w / W) * PX_PER_M; // px per metre on this canvas
    // World x of the front wheel contact point sits at FRONT[0] on screen.
    const originX = (FRONT[0] / W) * w - this.distance * scale;
    const toX = (m: number) => originX + m * scale;
    const p = this.palette;

    // Surface slabs.
    for (const seg of this.tape) {
      const x0 = Math.max(-10, toX(seg.from));
      const x1 = Math.min(w + 10, toX(seg.to));
      if (x1 < 0 || x0 > w) continue;
      ctx.fillStyle = seg.label === 'rough' ? p.line : p.ink3;
      ctx.globalAlpha = seg.label === 'stopped' ? 0.35 : 0.55;
      ctx.fillRect(x0, 4, x1 - x0, h - 4);
      ctx.globalAlpha = 1;
      if (seg.label === 'rough') {
        // Cobbles: staggered rounded stones.
        ctx.fillStyle = p.ink3;
        const size = Math.max(5, scale * 0.16);
        for (let row = 0; row < 3; row++) {
          const y = 6 + row * (size + 2);
          const offset = row % 2 ? size / 2 : 0;
          for (let x = Math.floor(x0 / (size + 2)) * (size + 2) + offset; x < x1; x += size + 2) {
            if (x + size < x0) continue;
            ctx.globalAlpha = 0.75;
            ctx.beginPath();
            ctx.roundRect(x, y, size, size, 2);
            ctx.fill();
          }
        }
        ctx.globalAlpha = 1;
      } else if (seg.label === 'smooth') {
        // Asphalt: a centre line and sparse grain.
        ctx.strokeStyle = p.halo;
        ctx.lineWidth = 1.5;
        ctx.setLineDash([scale * 0.5, scale * 0.6]);
        ctx.lineDashOffset = -originX;
        ctx.globalAlpha = 0.5;
        ctx.beginPath();
        ctx.moveTo(x0, h * 0.55);
        ctx.lineTo(x1, h * 0.55);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.globalAlpha = 1;
      } else if (seg.label === 'stopped') {
        // Stop line.
        ctx.strokeStyle = p.halo;
        ctx.lineWidth = 2;
        ctx.globalAlpha = 0.6;
        ctx.beginPath();
        ctx.moveTo(toX(seg.from) + 2, 6);
        ctx.lineTo(toX(seg.from) + 2, h);
        ctx.stroke();
        ctx.globalAlpha = 1;
      }
    }
    // Bumps: a raised edge.
    ctx.fillStyle = p.ink;
    for (const m of this.bumps) {
      const x = toX(m);
      if (x < -20 || x > w + 20) continue;
      ctx.globalAlpha = 0.8;
      ctx.beginPath();
      ctx.moveTo(x - 9, 5);
      ctx.quadraticCurveTo(x, -6, x + 9, 5);
      ctx.closePath();
      ctx.fill();
      ctx.globalAlpha = 1;
    }
    this.bumps = this.bumps.filter((m) => toX(m) > -40);
    // Top edge of the road.
    ctx.fillStyle = p.ink;
    ctx.globalAlpha = 0.5;
    ctx.fillRect(0, 3, w, 1.5);
    ctx.globalAlpha = 1;
  }

  /** Faint parallax skyline: moves at a quarter of the road speed. */
  private drawSky(): void {
    if (!this.sizeCanvas(this.sky)) return;
    const ctx = this.skyCtx;
    const dpr = this.sky.width / this.sky.clientWidth;
    const w = this.sky.clientWidth;
    const h = this.sky.clientHeight;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    const scroll = (this.distance * PX_PER_M * (w / W) * 0.25) % 1200;
    const base = h;
    ctx.fillStyle = this.palette.ink3;
    ctx.globalAlpha = 0.1;
    for (let rep = -1; rep <= 1; rep++) {
      for (const b of this.buildings) {
        const x = b.x - scroll + rep * 1200;
        if (x + b.w < 0 || x > w) continue;
        ctx.fillRect(x, base - b.h, b.w, b.h);
      }
    }
    // Lamp posts and tree crowns in the near layer.
    ctx.globalAlpha = 0.18;
    const near = (this.distance * PX_PER_M * (w / W) * 0.5) % 300;
    for (let x = -near; x < w + 300; x += 300) {
      ctx.fillRect(x + 20, base - 54, 2, 54);
      ctx.fillRect(x + 12, base - 56, 12, 3);
      ctx.beginPath();
      ctx.arc(x + 170, base - 30, 18, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillRect(x + 168, base - 20, 4, 20);
    }
    ctx.globalAlpha = 1;
  }
}

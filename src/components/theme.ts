/**
 * Theme management: light/dark/system, accent override, motion intensity
 * and a resolved palette (token values read back from CSS) for the parts
 * of the app that draw on canvas or WebGL and cannot use CSS variables.
 */
import type { AppConfig, ThemeSetting } from '../config/types';
import { Emitter } from '../utils/events';
import { prefersReducedMotion } from '../utils/dom';

export interface Palette {
  bg: string;
  surface: string;
  surfaceStrong: string;
  line: string;
  lineStrong: string;
  ink: string;
  ink2: string;
  ink3: string;
  accent: string;
  casing: string;
  halo: string;
  bikes: string[];
  /** Condition id -> colour. */
  conditions: Record<string, string>;
  unknown: string;
  fontDisplay: string;
  fontText: string;
  fontMono: string;
}

type ThemeEvents = { change: { dark: boolean; palette: Palette } };

export class ThemeManager extends Emitter<ThemeEvents> {
  private media = window.matchMedia('(prefers-color-scheme: dark)');
  private setting: ThemeSetting = 'system';
  private classes: AppConfig['classes'] = [];
  private accent = '';
  private motion = 1;
  palette!: Palette;

  constructor() {
    super();
    this.media.addEventListener('change', () => {
      if (this.setting === 'system') this.apply();
    });
  }

  configure(cfg: AppConfig): void {
    this.setting = cfg.theme;
    this.classes = cfg.classes;
    this.accent = cfg.accent;
    this.motion = cfg.motion;
    this.apply();
  }

  get dark(): boolean {
    return this.setting === 'dark' || (this.setting === 'system' && this.media.matches);
  }

  get current(): ThemeSetting {
    return this.setting;
  }

  /** Effective motion scale: 0 when the OS asks for reduced motion. */
  get motionScale(): number {
    return prefersReducedMotion() ? 0 : this.motion;
  }

  /** Cycles light -> dark -> light explicitly (used by the T shortcut). Returns the new setting. */
  next(): ThemeSetting {
    return this.dark ? 'light' : 'dark';
  }

  private apply(): void {
    const root = document.documentElement;
    root.dataset.theme = this.dark ? 'dark' : 'light';
    root.dataset.motion = this.motionScale === 0 ? '0' : '1';
    root.style.setProperty('--motion-scale', String(this.motionScale));
    if (this.accent) {
      root.style.setProperty('--accent', this.accent);
      root.style.setProperty(
        '--accent-soft',
        `color-mix(in srgb, ${this.accent} 14%, transparent)`,
      );
      root.style.setProperty(
        '--accent-line',
        `color-mix(in srgb, ${this.accent} 45%, transparent)`,
      );
      root.style.setProperty('--accent-ink', contrastInk(this.accent));
    } else {
      for (const p of ['--accent', '--accent-soft', '--accent-line', '--accent-ink'])
        root.style.removeProperty(p);
    }
    for (const c of this.classes) {
      const override = this.dark ? c.colourDark : c.colourLight;
      const prop = `--cond-${c.id}`;
      if (override) {
        root.style.setProperty(prop, override);
        root.style.setProperty(`${prop}-soft`, `color-mix(in srgb, ${override} 18%, transparent)`);
      } else {
        root.style.removeProperty(prop);
        root.style.removeProperty(`${prop}-soft`);
      }
    }
    this.palette = readPalette(this.classes.map((c) => c.id));
    this.emit('change', { dark: this.dark, palette: this.palette });
  }
}

function cssVar(name: string, fallback = ''): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;
}

export function readPalette(classIds: string[]): Palette {
  const conditions: Record<string, string> = {};
  for (const id of classIds) conditions[id] = cssVar(`--cond-${id}`, cssVar('--cond-unknown'));
  return {
    bg: cssVar('--bg'),
    surface: cssVar('--surface'),
    surfaceStrong: cssVar('--surface-strong'),
    line: cssVar('--line'),
    lineStrong: cssVar('--line-strong'),
    ink: cssVar('--ink'),
    ink2: cssVar('--ink-2'),
    ink3: cssVar('--ink-3'),
    accent: cssVar('--accent'),
    casing: cssVar('--map-casing'),
    halo: cssVar('--map-halo'),
    bikes: [1, 2, 3, 4].map((i) => cssVar(`--bike-${i}`)),
    conditions,
    unknown: cssVar('--cond-unknown'),
    fontDisplay: cssVar('--font-display'),
    fontText: cssVar('--font-text'),
    fontMono: cssVar('--font-mono'),
  };
}

/** Black or white text for a given background colour. */
export function contrastInk(colour: string): string {
  const rgb = parseColour(colour);
  if (!rgb) return '#ffffff';
  const [r, g, b] = rgb.map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  return lum > 0.4 ? '#0c1218' : '#ffffff';
}

export function parseColour(c: string): [number, number, number] | null {
  const hex = c.trim().match(/^#([0-9a-f]{3,8})$/i);
  if (hex) {
    let h = hex[1]!;
    if (h.length === 3 || h.length === 4)
      h = h
        .split('')
        .map((x) => x + x)
        .join('');
    return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
  }
  const rgb = c.match(/rgba?\(\s*([\d.]+)[ ,]+([\d.]+)[ ,]+([\d.]+)/);
  if (rgb) return [Number(rgb[1]), Number(rgb[2]), Number(rgb[3])];
  return null;
}

/** Returns an rgba() string with the given alpha for any parseable colour. */
export function withAlpha(colour: string, alpha: number): string {
  const rgb = parseColour(colour);
  return rgb ? `rgba(${rgb[0]}, ${rgb[1]}, ${rgb[2]}, ${alpha})` : colour;
}

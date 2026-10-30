/**
 * Settings drawer: live tweaks without code. Every change goes through
 * ConfigStore.update, which persists it and notifies the rest of the app.
 * Settings can be exported and imported as JSON and reset to the deployed
 * defaults from public/config.json.
 */
import type { ConfigStore } from '../config';
import type { AppConfig, PatternId } from '../config/types';
import { el, downloadBlob } from '../utils/dom';
import { readPalette } from './theme';
import { Drawer } from './drawer';
import type { Toasts } from './toast';

export class SettingsDrawer {
  readonly drawer: Drawer;
  private form!: HTMLFormElement;
  private rendering = false;

  constructor(
    host: HTMLElement,
    private readonly config: ConfigStore,
    private readonly toasts: Toasts,
    private readonly onSimulator: (patch: { speed?: number; secondBike?: boolean }) => void,
  ) {
    this.drawer = new Drawer(host, 'Settings', 'drawer-settings');
    this.render(config.current);
    config.on('change', (cfg) => {
      if (!this.rendering) this.render(cfg);
    });
  }

  private field(label: string, input: HTMLElement, hint?: string): HTMLElement {
    return el('label', { class: 'field' }, [
      el('span', { text: label }),
      input,
      hint ? el('span', { class: 'field-hint', text: hint }) : null,
    ]);
  }

  private render(cfg: AppConfig): void {
    this.rendering = true;
    const update = (patch: Parameters<ConfigStore['update']>[0]) => this.config.update(patch);
    const form = el('form', { class: 'settings-form' });
    form.addEventListener('submit', (e) => e.preventDefault());

    const section = (title: string, ...children: (HTMLElement | null)[]) =>
      el('section', { class: 'settings-section' }, [
        el('h3', { class: 't-label', text: title }),
        ...children,
      ]);

    // Appearance
    const theme = el('select');
    for (const [v, t] of [
      ['system', 'Follow the system'],
      ['light', 'Light'],
      ['dark', 'Dark'],
    ]) {
      theme.append(el('option', { value: v, text: t, selected: cfg.theme === v }));
    }
    theme.addEventListener('change', () => update({ theme: theme.value as AppConfig['theme'] }));

    const accent = el('input', { type: 'color', value: cfg.accent || '#1f6fe0' });
    const accentReset = el('button', { class: 'btn btn-ghost', type: 'button', text: 'Default' });
    accent.addEventListener('input', () => update({ accent: accent.value }));
    accentReset.addEventListener('click', () => update({ accent: '' }));

    const motion = el('input', {
      type: 'range',
      min: '0',
      max: '1',
      step: '0.1',
      value: String(cfg.motion),
    });
    motion.addEventListener('input', () => update({ motion: Number(motion.value) }));

    // Conditions
    const palette = readPalette(cfg.classes.map((c) => c.id));
    const classRows = cfg.classes.map((c, i) => {
      const current = toHex(palette.conditions[c.id] ?? '#888888');
      const light = el('input', {
        type: 'color',
        value: c.colourLight ?? current,
        title: 'Light theme colour',
      });
      const dark = el('input', {
        type: 'color',
        value: c.colourDark ?? current,
        title: 'Dark theme colour',
      });
      const pattern = el('select', { title: 'Pattern' });
      for (const p of ['solid', 'hatched', 'pin', 'hollow', 'dotted'] as PatternId[])
        pattern.append(el('option', { value: p, text: p, selected: c.pattern === p }));
      const apply = () => {
        const classes = cfg.classes.map((x, j) =>
          j === i
            ? {
                ...x,
                colourLight: light.value,
                colourDark: dark.value,
                pattern: pattern.value as PatternId,
              }
            : x,
        );
        update({ classes });
      };
      light.addEventListener('input', apply);
      dark.addEventListener('input', apply);
      pattern.addEventListener('change', apply);
      return el('div', { class: 'class-row' }, [
        el('span', { class: 'class-name', text: c.name }),
        light,
        dark,
        pattern,
      ]);
    });
    const resetColours = el('button', {
      class: 'btn btn-ghost',
      type: 'button',
      text: 'Reset colours',
    });
    resetColours.addEventListener('click', () => update({ classes: this.config.defaults.classes }));

    const aliases = el('textarea', { rows: '5' });
    aliases.value = Object.entries(cfg.aliases)
      .map(([k, v]) => `${k} = ${v}`)
      .join('\n');
    aliases.addEventListener('change', () => {
      const out: Record<string, string> = {};
      for (const line of aliases.value.split('\n')) {
        const m = line.match(/^\s*([^=#]+?)\s*=\s*([a-z0-9_-]+)\s*$/i);
        if (m) out[m[1]!.toLowerCase()] = m[2]!.toLowerCase();
      }
      this.config.replaceSettings({ ...this.config.exportSettings(), aliases: out });
    });

    const lowConf = el('input', {
      type: 'range',
      min: '0',
      max: '1',
      step: '0.05',
      value: String(cfg.lowConfidence),
    });
    const lowConfOut = el('output', {
      class: 't-num',
      text: `${Math.round(cfg.lowConfidence * 100)}%`,
    });
    lowConf.addEventListener('input', () => {
      lowConfOut.textContent = `${Math.round(Number(lowConf.value) * 100)}%`;
      update({ lowConfidence: Number(lowConf.value) });
    });

    // Data
    const joinWindow = el('input', {
      type: 'number',
      min: '500',
      max: '30000',
      step: '500',
      value: String(cfg.joinWindowMs),
    });
    joinWindow.addEventListener('change', () => update({ joinWindowMs: Number(joinWindow.value) }));
    const noData = el('input', {
      type: 'number',
      min: '5',
      max: '600',
      step: '5',
      value: String(cfg.broker.noDataTimeoutS),
    });
    noData.addEventListener('change', () =>
      update({ broker: { noDataTimeoutS: Number(noData.value) } }),
    );
    const segLen = el('input', {
      type: 'number',
      min: '10',
      max: '200',
      step: '5',
      value: String(cfg.segmentLengthM),
    });
    segLen.addEventListener('change', () => update({ segmentLengthM: Number(segLen.value) }));

    const comfortInputs = (['smoothWeight', 'roughWeight', 'bumpPenaltyPerKm'] as const).map(
      (k) => {
        const input = el('input', { type: 'number', step: '0.1', value: String(cfg.comfort[k]) });
        input.addEventListener('change', () => update({ comfort: { [k]: Number(input.value) } }));
        return this.field(
          {
            smoothWeight: 'Smooth weight',
            roughWeight: 'Rough weight',
            bumpPenaltyPerKm: 'Points per bump per km',
          }[k],
          input,
        );
      },
    );

    // Units
    const speedUnit = el('select');
    speedUnit.append(
      el('option', { value: 'kmh', text: 'km/h', selected: cfg.units.speed === 'kmh' }),
      el('option', { value: 'ms', text: 'm/s', selected: cfg.units.speed === 'ms' }),
    );
    speedUnit.addEventListener('change', () =>
      update({ units: { speed: speedUnit.value as 'kmh' | 'ms' } }),
    );
    const coordFmt = el('select');
    coordFmt.append(
      el('option', { value: 'dd', text: 'Decimal degrees', selected: cfg.units.coords === 'dd' }),
      el('option', {
        value: 'dms',
        text: 'Degrees, minutes, seconds',
        selected: cfg.units.coords === 'dms',
      }),
    );
    coordFmt.addEventListener('change', () =>
      update({ units: { coords: coordFmt.value as 'dd' | 'dms' } }),
    );

    // Map
    const styleLight = el('input', { type: 'url', value: cfg.map.styleLight });
    const styleDark = el('input', { type: 'url', value: cfg.map.styleDark });
    styleLight.addEventListener('change', () => update({ map: { styleLight: styleLight.value } }));
    styleDark.addEventListener('change', () => update({ map: { styleDark: styleDark.value } }));
    const geocode = el('input', { type: 'checkbox', checked: cfg.geocoding.enabled });
    geocode.addEventListener('change', () => update({ geocoding: { enabled: geocode.checked } }));

    // Simulator
    const simSpeed = el('select');
    for (const v of [1, 4, 10])
      simSpeed.append(
        el('option', { value: String(v), text: `${v}x`, selected: cfg.simulator.speed === v }),
      );
    simSpeed.addEventListener('change', () => {
      update({ simulator: { speed: Number(simSpeed.value) } });
      this.onSimulator({ speed: Number(simSpeed.value) });
    });
    const second = el('input', { type: 'checkbox', checked: cfg.simulator.secondBike });
    second.addEventListener('change', () => {
      update({ simulator: { secondBike: second.checked } });
      this.onSimulator({ secondBike: second.checked });
    });
    const errorRate = el('input', {
      type: 'range',
      min: '0',
      max: '0.2',
      step: '0.01',
      value: String(cfg.simulator.errorRate),
    });
    errorRate.addEventListener('input', () =>
      update({ simulator: { errorRate: Number(errorRate.value) } }),
    );

    // Import, export, reset
    const exportBtn = el('button', { class: 'btn', type: 'button', text: 'Export JSON' });
    exportBtn.addEventListener('click', () => {
      const blob = new Blob([JSON.stringify(this.config.exportSettings(), null, 2)], {
        type: 'application/json',
      });
      downloadBlob(blob, 'dashboard-settings.json');
    });
    const importInput = el('input', {
      type: 'file',
      accept: 'application/json,.json',
      hidden: true,
    });
    importInput.addEventListener('change', async () => {
      const file = importInput.files?.[0];
      if (!file) return;
      try {
        this.config.replaceSettings(JSON.parse(await file.text()));
        this.toasts.show('Settings imported', 'ok');
      } catch {
        this.toasts.show('That file is not valid settings JSON', 'warn');
      }
      importInput.value = '';
    });
    const importBtn = el('button', { class: 'btn', type: 'button', text: 'Import JSON' });
    importBtn.addEventListener('click', () => importInput.click());
    const resetBtn = el('button', {
      class: 'btn btn-ghost',
      type: 'button',
      text: 'Reset to defaults',
    });
    resetBtn.addEventListener('click', () => {
      this.config.resetSettings();
      this.toasts.show('Settings reset to config.json defaults', 'ok');
    });

    form.append(
      section(
        'Appearance',
        this.field('Theme', theme),
        this.field('Accent colour', el('div', { class: 'field-row' }, [accent, accentReset])),
        this.field('Animation intensity', motion, '0 switches decorative motion off'),
      ),
      section(
        'Road conditions',
        el('div', { class: 'class-head t-label' }, [
          el('span', { text: 'Class' }),
          el('span', { text: 'Light' }),
          el('span', { text: 'Dark' }),
          el('span', { text: 'Pattern' }),
        ]),
        ...classRows,
        resetColours,
        this.field(
          'Label aliases (one per line: model label = class)',
          aliases,
          'Lets the dashboard accept names the trained model uses',
        ),
        this.field(
          'Faint display below confidence',
          el('div', { class: 'field-row' }, [lowConf, lowConfOut]),
        ),
      ),
      section(
        'Data',
        this.field('GPS join window (ms)', joinWindow),
        this.field('No-data warning after (s)', noData),
        this.field('Area report segment length (m)', segLen),
      ),
      section('Comfort score', ...comfortInputs),
      section('Units', this.field('Speed', speedUnit), this.field('Coordinates', coordFmt)),
      section(
        'Map',
        this.field('Light style URL', styleLight),
        this.field('Dark style URL', styleDark),
        this.field(
          'Street names from Nominatim',
          el('div', { class: 'field-row' }, [
            geocode,
            el('span', { class: 'field-hint', text: 'At most one request per second, cached' }),
          ]),
        ),
      ),
      section(
        'Simulator',
        this.field('Speed', simSpeed),
        this.field('Second bike', second),
        this.field('Model error rate', errorRate),
      ),
      section(
        'Settings file',
        el('div', { class: 'field-row' }, [exportBtn, importBtn, importInput, resetBtn]),
        el('p', {
          class: 'field-hint',
          text: 'Defaults come from public/config.json. Your changes are stored in this browser only.',
        }),
      ),
    );
    this.form?.remove();
    this.form = form;
    this.drawer.body.append(form);
    this.rendering = false;
  }
}

/** The colour input only accepts #rrggbb. */
function toHex(colour: string): string {
  if (/^#[0-9a-f]{6}$/i.test(colour)) return colour;
  const m = colour.match(/rgba?\(\s*(\d+)[ ,]+(\d+)[ ,]+(\d+)/);
  if (!m) return '#888888';
  return '#' + [m[1], m[2], m[3]].map((v) => Number(v).toString(16).padStart(2, '0')).join('');
}

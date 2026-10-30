/**
 * Top bar: title and source chip, bike selector, connection status and the
 * tool buttons (pipeline, raw signals, exports, theme, presentation, settings, help).
 */
import type { AppConfig } from '../config/types';
import type { RideStore, SourceKind } from '../data/store';
import { el } from '../utils/dom';
import { icons, type IconName } from './icons';

export interface HeaderActions {
  onConnect(): void;
  onPipeline(): void;
  onSignals(): void;
  onExport(): void;
  onTheme(): void;
  onPresent(): void;
  onSettings(): void;
  onHelp(): void;
}

export class Header {
  private title: HTMLElement;
  private chip: HTMLElement;
  private chipDetail: HTMLElement;
  private bikes: HTMLElement;
  private connectBtn: HTMLButtonElement;
  private buttons = new Map<string, HTMLButtonElement>();

  constructor(
    private readonly root: HTMLElement,
    private readonly store: RideStore,
    cfg: AppConfig,
    actions: HeaderActions,
  ) {
    this.title = el('h1', { class: 'brand-title t-display', text: cfg.title });
    this.chip = el('span', { class: 'source-chip', 'data-kind': 'simulated' }, [
      el('i', { class: 'source-dot motion' }),
      el('span', { class: 'source-text', text: 'Simulation' }),
    ]);
    this.chipDetail = el('span', { class: 'source-detail t-num' });
    this.bikes = el('div', { class: 'bike-pills', role: 'tablist', 'aria-label': 'Bikes' });
    this.connectBtn = el('button', {
      class: 'btn',
      type: 'button',
      title: 'Data source: connect to the broker, simulate or replay',
    });
    this.connectBtn.innerHTML = `${icons.link}<span>Source</span>`;
    this.connectBtn.addEventListener('click', actions.onConnect);

    const tool = (name: string, icon: IconName, title: string, fn: () => void, toggle = false) => {
      const b = el('button', { class: 'btn btn-icon', type: 'button', title, 'aria-label': title });
      if (toggle) b.setAttribute('aria-pressed', 'false');
      b.innerHTML = icons[icon];
      b.addEventListener('click', fn);
      this.buttons.set(name, b);
      return b;
    };

    root.append(
      el('div', { class: 'brand' }, [
        el('span', { class: 'brand-mark', html: icons.bike }),
        el('div', { class: 'brand-text' }, [
          this.title,
          el('div', { class: 'brand-sub' }, [this.chip, this.chipDetail]),
        ]),
      ]),
      this.bikes,
      el('div', { class: 'topbar-tools' }, [
        this.connectBtn,
        tool('pipeline', 'pipeline', 'System pipeline (P)', actions.onPipeline, true),
        tool('signals', 'signal', 'Raw IMU signals', actions.onSignals, true),
        tool('export', 'download', 'Export the ride', actions.onExport),
        tool('theme', 'moon', 'Switch theme (T)', actions.onTheme),
        tool(
          'present',
          'present',
          'Presentation mode (F for full screen)',
          actions.onPresent,
          true,
        ),
        tool('settings', 'settings', 'Settings', actions.onSettings, true),
        tool('help', 'help', 'Keyboard shortcuts (?)', actions.onHelp),
      ]),
    );

    store.on('device-added', () => this.renderBikes());
    store.on('device-selected', () => this.renderBikes());
    store.on('reset', () => this.renderBikes());
    store.on('source-kind', (k) => this.setSource(k));
    this.renderBikes();
  }

  setConfig(cfg: AppConfig): void {
    this.title.textContent = cfg.title;
    document.title = cfg.title;
  }

  setPressed(name: string, on: boolean): void {
    this.buttons.get(name)?.setAttribute('aria-pressed', String(on));
  }

  setThemeIcon(dark: boolean): void {
    const b = this.buttons.get('theme');
    if (b) b.innerHTML = dark ? icons.sun : icons.moon;
  }

  setSource(kind: SourceKind, detail = ''): void {
    this.chip.dataset.kind = kind;
    const text = this.chip.querySelector('.source-text')!;
    text.textContent = kind === 'live' ? 'Live' : kind === 'replay' ? 'Replay' : 'Simulation';
    this.chipDetail.textContent = detail;
    document.getElementById('app')?.setAttribute('data-source', kind);
  }

  setDetail(detail: string): void {
    this.chipDetail.textContent = detail;
  }

  setConnection(state: 'off' | 'connecting' | 'on' | 'offline' | 'error', detail = ''): void {
    this.connectBtn.dataset.state = state;
    this.connectBtn.title = detail || 'Data source';
  }

  private renderBikes(): void {
    this.bikes.replaceChildren();
    const list = this.store.deviceList;
    list.forEach((d, i) => {
      const b = el('button', {
        class: `bike-pill ${d.id === this.store.selectedId ? 'is-active' : ''}`,
        type: 'button',
        role: 'tab',
        'aria-selected': String(d.id === this.store.selectedId),
        title: `Select ${d.id} (${i + 1})`,
      });
      b.style.setProperty('--bike', `var(--bike-${d.slot})`);
      b.append(el('i'), el('span', { text: d.id }));
      b.addEventListener('click', () => this.store.select(d.id));
      this.bikes.append(b);
    });
    this.bikes.hidden = list.length < 2;
  }
}

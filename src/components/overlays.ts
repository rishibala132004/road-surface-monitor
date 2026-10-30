/**
 * Layers drawn over the map: place name and coordinates of the selected
 * bike, GPS quality, the map tool buttons, the condition legend, the cursor
 * coordinate readout and the "no data" banner.
 */
import type { AppConfig } from '../config/types';
import type { RideStore } from '../data/store';
import type { MapController } from '../map/map';
import type { Geocoder } from '../map/geocode';
import { el } from '../utils/dom';
import { formatCoords, formatPercent } from '../utils/format';
import { icons, type IconName } from './icons';

export class MapOverlays {
  private street: HTMLElement;
  private area: HTMLElement;
  private coords: HTMLElement;
  private gps: HTMLElement;
  private cursor: HTMLElement;
  private legend: HTMLElement;
  private banner: HTMLElement;
  private styleNote: HTMLElement;
  private tools = new Map<string, HTMLButtonElement>();
  private lastGeocodeKey = '';
  private lastTick = 0;
  private cfg: AppConfig;

  constructor(
    private readonly root: HTMLElement,
    private readonly store: RideStore,
    private readonly map: MapController,
    private readonly geocoder: Geocoder,
    cfg: AppConfig,
    onAggregate: (on: boolean) => void,
  ) {
    this.cfg = cfg;
    this.street = el('div', { class: 'place-street', text: 'Locating' });
    this.area = el('div', { class: 'place-area' });
    this.coords = el('div', { class: 'place-coords t-num' });
    this.gps = el('div', { class: 'place-gps t-num' });
    const card = el('div', { class: 'place-card' }, [
      this.street,
      this.area,
      this.coords,
      this.gps,
    ]);

    const tool = (name: string, icon: IconName, title: string, fn: () => void, toggle = false) => {
      const b = el('button', { class: 'btn btn-icon', type: 'button', title, 'aria-label': title });
      if (toggle) b.setAttribute('aria-pressed', 'false');
      b.innerHTML = icons[icon];
      b.addEventListener('click', fn);
      this.tools.set(name, b);
      return b;
    };
    const tools = el('div', { class: 'map-tools' }, [
      tool('follow', 'follow', 'Follow the bike', () => map.setFollow(!map.follow), true),
      tool('overview', 'overview', 'Overview: fit the whole ride (O)', () => map.fitRide()),
      tool(
        'heading',
        'heading',
        'Heading-up or north-up',
        () => map.setHeadingUp(!map.headingUp),
        true,
      ),
      tool('reset', 'reset', 'Reset the view', () => map.resetView()),
      el('div', { class: 'sep' }),
      tool('zoomin', 'plus', 'Zoom in', () => map.map.zoomIn()),
      tool('zoomout', 'minus', 'Zoom out', () => map.map.zoomOut()),
      el('div', { class: 'sep' }),
      tool(
        'grid',
        'grid',
        'Latitude and longitude grid',
        () => map.setGraticule(!map.graticuleOn),
        true,
      ),
      tool(
        'hex',
        'hex',
        'Aggregated road quality from all rides',
        () => onAggregate(!map.aggregateOn),
        true,
      ),
    ]);

    this.legend = el('div', { class: 'legend', 'aria-label': 'Legend' });
    this.cursor = el('div', { class: 'cursor-coords t-num', hidden: true });
    this.banner = el('div', { class: 'notice-banner', role: 'alert', hidden: true });
    this.styleNote = el('div', {
      class: 'map-style-note',
      hidden: true,
      text: 'Map tiles unavailable offline. The ride is still drawn.',
    });
    root.append(
      card,
      this.banner,
      this.styleNote,
      tools,
      el('div', { class: 'map-footer' }, [this.legend, this.cursor]),
    );

    map.on('cursor', (c) => {
      this.cursor.hidden = !c;
      if (c) this.cursor.textContent = formatCoords(c.lat, c.lon, this.cfg.units.coords);
    });
    map.on('follow', (on) => this.tools.get('follow')?.setAttribute('aria-pressed', String(on)));
    map.on('style-status', (s) => (this.styleNote.hidden = s !== 'offline'));
    this.tools.get('follow')?.setAttribute('aria-pressed', String(map.follow));
    this.tools.get('grid')?.setAttribute('aria-pressed', String(map.graticuleOn));
    this.buildLegend();
  }

  setConfig(cfg: AppConfig): void {
    this.cfg = cfg;
    this.buildLegend();
  }

  setHeadingPressed(on: boolean): void {
    this.tools.get('heading')?.setAttribute('aria-pressed', String(on));
  }

  setGridPressed(on: boolean): void {
    this.tools.get('grid')?.setAttribute('aria-pressed', String(on));
  }

  setHexPressed(on: boolean): void {
    this.tools.get('hex')?.setAttribute('aria-pressed', String(on));
  }

  showBanner(text: string | null, kind: 'danger' | 'warn' | 'info' = 'danger'): void {
    this.banner.hidden = !text;
    if (text) {
      this.banner.textContent = text;
      this.banner.dataset.kind = kind;
    }
  }

  private buildLegend(): void {
    this.legend.replaceChildren(el('div', { class: 't-label', text: 'Road condition' }));
    for (const c of this.cfg.classes) {
      const sw = el('span', { class: 'swatch', 'data-pattern': c.pattern });
      sw.style.setProperty('--c', `var(--cond-${c.id})`);
      this.legend.append(
        el('div', { class: 'legend-row', 'data-id': c.id }, [
          sw,
          el('span', { text: c.name }),
          el('span', { class: 'legend-share t-num', text: '' }),
        ]),
      );
    }
    const low = el('span', { class: 'swatch', 'data-pattern': 'dotted' });
    low.style.setProperty('--c', 'var(--ink-3)');
    this.legend.append(
      el('div', { class: 'legend-row' }, [
        low,
        el('span', { text: `Below ${formatPercent(this.cfg.lowConfidence)} confidence` }),
        el('span'),
      ]),
    );
  }

  frame(now: number): void {
    if (now - this.lastTick < 300) return;
    this.lastTick = now;
    const d = this.store.selected;
    const pos = d ? this.store.positionAt(d, this.store.viewTs) : null;
    if (!d || !pos) {
      this.street.textContent = 'Waiting for a position';
      this.area.textContent = '';
      this.coords.textContent = '';
      this.gps.textContent = '';
      return;
    }
    this.coords.textContent = formatCoords(pos.lat, pos.lon, this.cfg.units.coords);
    const latest = d.gps.latest;
    const ageS =
      latest && this.store.isLive ? Math.max(0, (Date.now() - latest.receivedAt) / 1000) : 0;
    const acc = pos.acc;
    const quality = acc != null && acc > 15 ? 'poor' : ageS > 5 ? 'poor' : 'ok';
    this.gps.dataset.quality = quality;
    this.gps.textContent = this.store.isLive
      ? `GPS ${acc != null ? `±${acc.toFixed(0)} m` : ''} ${latest ? `${ageS.toFixed(0)} s ago` : 'none'}${pos.interpolated ? ' interpolated' : ''}`
      : `GPS ${acc != null ? `±${acc.toFixed(0)} m` : ''} ${pos.interpolated ? 'interpolated' : ''}`;

    const key = `${pos.lat.toFixed(4)}:${pos.lon.toFixed(4)}`;
    if (key !== this.lastGeocodeKey) {
      this.lastGeocodeKey = key;
      const quick = this.geocoder.lookupSync([pos.lon, pos.lat]);
      if (quick.street) this.setPlace(quick.street, quick.area);
      this.geocoder.prioritise([pos.lon, pos.lat]);
      void this.geocoder.lookup([pos.lon, pos.lat]).then((place) => {
        if (this.lastGeocodeKey !== key) return;
        if (place.street) this.setPlace(place.street, place.area);
        else this.setPlace(formatCoords(pos.lat, pos.lon, 'dd'), 'No street name available');
      });
    }
    for (const row of this.legend.querySelectorAll<HTMLElement>('.legend-row[data-id]')) {
      const share = d.stats.shares.find((s) => s.id === row.dataset.id);
      row.querySelector('.legend-share')!.textContent =
        share && share.count ? formatPercent(share.share) : '';
    }
  }

  private setPlace(street: string, area: string): void {
    if (this.street.textContent !== street) this.street.textContent = street;
    this.area.textContent = area;
  }
}

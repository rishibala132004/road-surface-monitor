/**
 * Area report: the ride split into short segments, snapped to street names
 * through reverse geocoding, summarised per street (worst first). Clicking
 * a street highlights and frames it on the map. Also builds the aggregated
 * hex layer from every ride seen in this session.
 */
import type { AppConfig } from '../config/types';
import type { RideStore, Sample } from '../data/store';
import type { Geocoder } from '../map/geocode';
import { buildHexGrid } from '../map/layers';
import type { MapController } from '../map/map';
import { groupByStreet, segmentRide, type Segment, type StreetReport } from '../map/segments';
import { el } from '../utils/dom';
import { formatDistance, formatPercent } from '../utils/format';

export class AreaReport {
  private list: HTMLElement;
  private empty: HTMLElement;
  private cfg: AppConfig;
  private lastBuild = 0;
  private lastCount = -1;
  private active: string | null = null;
  private reports: StreetReport[] = [];
  /** Positioned samples from rides that ended (source switches), for the aggregate layer. */
  private archive: Sample[][] = [];
  private hexDirty = true;

  constructor(
    root: HTMLElement,
    private readonly store: RideStore,
    private readonly map: MapController,
    private readonly geocoder: Geocoder,
    cfg: AppConfig,
  ) {
    this.cfg = cfg;
    this.list = el('div', { class: 'streets' });
    this.empty = el('p', {
      class: 'report-empty',
      text: 'Street names appear once the ride has covered a few segments.',
    });
    const clear = el('button', { class: 'btn btn-ghost', type: 'button', text: 'Clear highlight' });
    clear.addEventListener('click', () => this.highlight(null));
    root.append(
      el('section', { class: 'rail-section is-secondary report-section' }, [
        el('div', { class: 'rail-head' }, [
          el('span', { class: 't-label', text: 'Area report' }),
          el('span', { class: 't-label', text: 'worst first' }),
        ]),
        this.empty,
        this.list,
        el('div', { class: 'report-tools' }, [clear]),
      ]),
    );
    store.on('device-selected', () => {
      this.lastCount = -1;
      this.highlight(null);
    });
    store.on('reset', () => {
      this.lastCount = -1;
      this.reports = [];
      this.list.replaceChildren();
      this.highlight(null);
    });
  }

  setConfig(cfg: AppConfig): void {
    this.cfg = cfg;
    this.lastCount = -1;
    this.hexDirty = true;
  }

  /** Keeps a copy of the ride before the store is cleared, for the aggregate layer. */
  archiveCurrent(): void {
    for (const d of this.store.devices.values()) {
      const positioned = d.samples.filter((s) => s.pos);
      if (positioned.length > 10) this.archive.push(positioned);
    }
    if (this.archive.length > 20) this.archive.splice(0, this.archive.length - 20);
    this.hexDirty = true;
  }

  get rideCount(): number {
    return this.archive.length + this.store.devices.size;
  }

  /** Rebuilds the hex grid from archived and current rides. */
  refreshHex(force = false): void {
    if (!force && !this.hexDirty) return;
    this.hexDirty = false;
    const sets = [...this.archive, ...[...this.store.devices.values()].map((d) => d.samples)];
    this.map.setHexData(
      buildHexGrid(sets, 28, {
        smooth: this.cfg.comfort.smoothWeight,
        rough: this.cfg.comfort.roughWeight,
      }),
    );
  }

  frame(now: number): void {
    if (now - this.lastBuild < 5000) return;
    this.lastBuild = now;
    this.hexDirty = true;
    if (this.map.aggregateOn) this.refreshHex(true);
    const d = this.store.selected;
    if (!d) return;
    if (d.samples.length === this.lastCount) return;
    this.lastCount = d.samples.length;
    const segments = segmentRide(d, this.cfg.segmentLengthM);
    this.nameSegments(segments);
    this.reports = groupByStreet(
      segments,
      this.cfg.comfort,
      this.cfg.classes.map((c) => c.id),
    );
    this.render();
  }

  /** Assigns street names: cached geocodes first, then queue lookups roughly every 100 m. */
  private nameSegments(segments: Segment[]): void {
    let sinceLookup = Infinity;
    let lastName = '';
    for (const seg of segments) {
      const place = this.geocoder.lookupSync(seg.mid);
      if (place.street) {
        seg.street = place.street;
        lastName = place.street;
      } else {
        seg.street = lastName;
      }
      sinceLookup += seg.metres;
      if (sinceLookup >= 100 && place.source !== 'nominatim') {
        sinceLookup = 0;
        void this.geocoder.lookup(seg.mid).then(() => (this.lastCount = -1));
      }
    }
    // Forward fill names for the first segments if the first lookup came late.
    let next = '';
    for (let i = segments.length - 1; i >= 0; i--) {
      const seg = segments[i]!;
      if (seg.street) next = seg.street;
      else seg.street = next;
    }
  }

  private render(): void {
    this.list.replaceChildren();
    this.empty.hidden = this.reports.length > 0;
    for (const r of this.reports.slice(0, 12)) {
      const strip = el('div', { class: 'street-strip' });
      // Compress long streets to at most 40 cells.
      const step = Math.max(1, Math.ceil(r.strip.length / 40));
      for (let i = 0; i < r.strip.length; i += step) {
        const label = r.strip[i]!;
        const cell = el('i', { 'data-label': label });
        cell.style.setProperty(
          '--c',
          `var(--cond-${this.cfg.classes.some((c) => c.id === label) ? label : 'unknown'})`,
        );
        strip.append(cell);
      }
      const shares = this.cfg.classes
        .filter((c) => (r.shares[c.id] ?? 0) > 0.005)
        .map((c) => `${c.name.toLowerCase()} ${formatPercent(r.shares[c.id] ?? 0)}`)
        .join(', ');
      const item = el(
        'button',
        { class: `street ${this.active === r.name ? 'is-active' : ''}`, type: 'button' },
        [
          el('span', { class: 'street-name', text: r.name }),
          el('span', {
            class: 'street-score t-num',
            text: String(r.comfort),
            title: 'Comfort score',
          }),
          strip,
          el('span', {
            class: 'street-meta',
            text: `${formatDistance(r.metres)}, ${r.bumps} bump${r.bumps === 1 ? '' : 's'}, ${shares}`,
          }),
        ],
      );
      item.addEventListener('click', () => this.highlight(this.active === r.name ? null : r.name));
      this.list.append(item);
    }
  }

  private highlight(name: string | null): void {
    this.active = name;
    const report = name ? (this.reports.find((r) => r.name === name) ?? null) : null;
    this.map.highlightStreet(report);
    for (const node of this.list.children)
      node.classList.toggle('is-active', node.querySelector('.street-name')?.textContent === name);
  }
}

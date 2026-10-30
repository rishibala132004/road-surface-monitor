/**
 * Exports: .jsonl log (replayable), GeoJSON of the coloured route and bump
 * points, CSV of all condition samples, PNG snapshot of the map with a legend.
 */
import type { AppConfig } from '../config/types';
import type { RideStore } from '../data/store';
import type { MapController } from '../map/map';
import { bumpCollection, rideCollection } from '../map/layers';
import { downloadBlob, el } from '../utils/dom';
import { Drawer } from './drawer';
import type { Toasts } from './toast';

function stamp(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}

export function toJsonl(store: RideStore): string {
  return (
    store.records
      .map((r) => JSON.stringify({ t: r.receivedAt, topic: r.topic, payload: r.payload }))
      .join('\n') + '\n'
  );
}

export function toGeoJson(store: RideStore, cfg: AppConfig): string {
  const ride = rideCollection(store);
  const bumps = bumpCollection(store);
  const colours: Record<string, string> = {};
  for (const c of cfg.classes) colours[c.id] = c.colourLight ?? '';
  const features: GeoJSON.Feature[] = [
    ...ride.features.map((f) => ({
      ...f,
      properties: {
        ...f.properties,
        kind: 'segment',
        name: cfg.classes.find((c) => c.id === f.properties.label)?.name ?? f.properties.label,
        stroke: colours[f.properties.label] || undefined,
        'stroke-width': 4,
      },
    })),
    ...bumps.features.map((f) => ({
      ...f,
      properties: {
        ...f.properties,
        kind: 'bump',
        'marker-color': colours.bump || undefined,
        'marker-symbol': 'triangle',
      },
    })),
  ];
  return JSON.stringify({ type: 'FeatureCollection', features }, null, 1);
}

export function toCsv(store: RideStore, cfg: AppConfig): string {
  const ids = cfg.classes.map((c) => c.id);
  const head = [
    'device',
    'ts',
    'iso_time',
    'label',
    'raw_label',
    'confidence',
    'vib_ms2',
    'inference_ms',
    'seq',
    'lat',
    'lon',
    'speed_kmh',
    'gps_acc_m',
    'distance_m',
    ...ids.map((id) => `p_${id}`),
  ];
  const rows = [head.join(',')];
  for (const d of store.devices.values()) {
    for (const s of d.samples) {
      rows.push(
        [
          d.id,
          s.ts,
          new Date(s.ts).toISOString(),
          s.label,
          JSON.stringify(s.rawLabel),
          s.confidence.toFixed(3),
          s.vibMeasured ? s.vib.toFixed(2) : '',
          s.inferenceMs ?? '',
          s.seq ?? '',
          s.pos ? s.pos.lat.toFixed(6) : '',
          s.pos ? s.pos.lon.toFixed(6) : '',
          s.speed != null ? s.speed.toFixed(1) : '',
          s.pos?.acc ?? '',
          s.distanceM.toFixed(1),
          ...ids.map((id) => (s.scores?.[id] != null ? s.scores[id]!.toFixed(3) : '')),
        ].join(','),
      );
    }
  }
  return rows.join('\n') + '\n';
}

export class ExportDrawer {
  readonly drawer: Drawer;
  private info: HTMLElement;

  constructor(
    host: HTMLElement,
    private readonly store: RideStore,
    private readonly map: MapController,
    private cfg: AppConfig,
    private readonly toasts: Toasts,
  ) {
    this.drawer = new Drawer(host, 'Export the ride', 'drawer-export');
    this.info = el('p', { class: 'field-hint' });
    const btn = (text: string, hint: string, fn: () => void | Promise<void>) => {
      const b = el('button', { class: 'btn', type: 'button', text });
      b.addEventListener('click', () => void fn());
      return el('div', { class: 'export-row' }, [
        b,
        el('span', { class: 'field-hint', text: hint }),
      ]);
    };
    this.drawer.body.append(
      this.info,
      btn('Log (.jsonl)', 'Every message as received. Load it back with the replay source.', () =>
        this.save(toJsonl(store), 'application/x-ndjson', 'jsonl'),
      ),
      btn(
        'Route (GeoJSON)',
        'Coloured route segments and bump points. Opens in geojson.io or QGIS.',
        () => this.save(toGeoJson(store, this.cfg), 'application/geo+json', 'geojson'),
      ),
      btn(
        'Samples (CSV)',
        'One row per classification, with position, speed and class probabilities.',
        () => this.save(toCsv(store, this.cfg), 'text/csv', 'csv'),
      ),
      btn('Map snapshot (PNG)', 'The current map view with the bikes and a legend.', () =>
        this.snapshot(),
      ),
    );
    this.drawer.onClose(() => undefined);
  }

  setConfig(cfg: AppConfig): void {
    this.cfg = cfg;
  }

  open(): void {
    const n = this.store.records.length;
    const samples = [...this.store.devices.values()].reduce((a, d) => a + d.samples.length, 0);
    this.info.textContent = `${n} messages recorded, ${samples} classifications, ${this.store.devices.size} bike${this.store.devices.size === 1 ? '' : 's'} (${this.store.sourceKind}).`;
    this.drawer.show();
  }

  private save(text: string, type: string, ext: string): void {
    const name = `ride-${stamp()}.${ext}`;
    downloadBlob(new Blob([text], { type }), name);
    this.toasts.show(`Exported ${name}`, 'ok');
  }

  private async snapshot(): Promise<void> {
    try {
      const blob = await this.map.snapshot(
        this.cfg.title,
        this.cfg.classes.map((c) => ({ id: c.id, name: c.name, pattern: c.pattern })),
      );
      const name = `map-${stamp()}.png`;
      downloadBlob(blob, name);
      this.toasts.show(`Exported ${name}`, 'ok');
    } catch {
      this.toasts.show('Snapshot failed', 'warn');
    }
  }
}

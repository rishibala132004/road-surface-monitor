/**
 * The map: MapLibre GL set-up, theme-dependent styles, the ride layers
 * (ribbon, bumps, markers, ghost, highlight, hex aggregate, graticule) and
 * the camera modes (follow with speed-adaptive zoom, overview, north-up or
 * heading-up).
 *
 * The map keeps no ride data of its own: `refresh()` rebuilds the GeoJSON
 * from the store when something changed, and `frame()` moves the markers
 * smoothly between GPS fixes.
 */
import * as maplibregl from 'maplibre-gl';
import type {
  ExpressionSpecification,
  LngLatBoundsLike,
  Map as MlMap,
  StyleSpecification,
} from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
// MapLibre looks for its worker next to its own module, which a bundled build
// does not provide. Vite bundles the worker and hands over its URL instead.
import mapWorkerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url';
import type { AppConfig } from '../config/types';
import type { DeviceState, RideStore } from '../data/store';
import { Emitter } from '../utils/events';
import { bearingDelta, type LonLat } from '../utils/geo';
import { clamp } from '../utils/format';
import { el } from '../utils/dom';
import type { Palette, ThemeManager } from '../components/theme';
import { withAlpha } from '../components/theme';
import { bumpCollection, rideCollection, type HexProps } from './layers';
import type { StreetReport } from './segments';

type MapEvents = {
  cursor: { lat: number; lon: number } | null;
  follow: boolean;
  view: void;
  'style-status': 'loading' | 'ready' | 'offline';
  'hover-sample': { ts: number; device: string; label: string } | null;
};

interface MarkerState {
  marker: maplibregl.Marker;
  el: HTMLElement;
  arrow: HTMLElement;
  from: LonLat;
  to: LonLat;
  heading: number;
  startedAt: number;
  label: string;
}

maplibregl.setWorkerUrl(mapWorkerUrl);

const EMPTY_FC: GeoJSON.FeatureCollection = { type: 'FeatureCollection', features: [] };

export class MapController extends Emitter<MapEvents> {
  readonly map: MlMap;
  follow = true;
  headingUp = false;
  graticuleOn: boolean;
  aggregateOn = false;
  private cfg: AppConfig;
  private palette: Palette;
  private styleReady = false;
  private dirty = true;
  private lastRefresh = 0;
  private markers = new Map<string, MarkerState>();
  private ghost: maplibregl.Marker | null = null;
  private popup: maplibregl.Popup;
  private zoomEma: number;
  private lastEaseTarget: LonLat | null = null;
  private suppressInteraction = 0;
  private hoverFeatureKey = '';
  private styleTimer: ReturnType<typeof setTimeout> | null = null;
  private hexData: GeoJSON.FeatureCollection<GeoJSON.Polygon, HexProps> = {
    type: 'FeatureCollection',
    features: [],
  };
  private readonly motion: () => number;

  constructor(
    container: HTMLElement,
    cfg: AppConfig,
    private readonly theme: ThemeManager,
    private readonly store: RideStore,
  ) {
    super();
    this.cfg = cfg;
    this.palette = theme.palette;
    this.graticuleOn = cfg.map.graticule;
    this.zoomEma = cfg.map.followZoomSlow;
    this.motion = () => theme.motionScale;

    this.map = new maplibregl.Map({
      container,
      style: this.styleUrl(theme.dark),
      center: cfg.map.center,
      zoom: cfg.map.zoom,
      pitch: 0,
      bearing: 0,
      attributionControl: { compact: true },
      fadeDuration: 150,
      maxPitch: 60,
      dragRotate: true,
      pitchWithRotate: true,
      touchPitch: true,
    });
    this.map.addControl(
      new maplibregl.ScaleControl({ maxWidth: 140, unit: 'metric' }),
      'bottom-right',
    );
    this.popup = new maplibregl.Popup({
      closeButton: false,
      closeOnClick: false,
      offset: 10,
      className: 'ride-popup',
    });

    this.map.on('style.load', () => this.onStyleLoad());
    this.armStyleTimeout();
    this.map.on('error', (e) => this.onError(e));
    this.map.on('mousemove', (e) => {
      this.emit('cursor', { lat: e.lngLat.lat, lon: e.lngLat.lng });
      this.hoverRide(e.point);
    });
    this.map.on('mouseout', () => {
      this.emit('cursor', null);
      this.clearHover();
    });
    for (const ev of ['dragstart', 'zoomstart', 'rotatestart', 'pitchstart'] as const) {
      this.map.on(ev, (e) => {
        const userDriven = 'originalEvent' in e && !!(e as { originalEvent?: Event }).originalEvent;
        if (userDriven && this.suppressInteraction === 0) this.setFollow(false);
      });
    }
    this.map.on('wheel', () => this.setFollow(false));
    this.map.on('moveend', () => {
      if (this.graticuleOn) this.updateGraticule();
      this.emit('view', undefined);
    });

    theme.on('change', ({ dark, palette }) => {
      this.palette = palette;
      this.setStyleFor(dark);
    });
    store.on('reset', () => this.clearMarkers());
    store.on('bump', ({ sample }) => {
      if (sample.pos && this.motion() > 0) this.ripple([sample.pos.lon, sample.pos.lat]);
    });
  }

  setConfig(cfg: AppConfig): void {
    const styleChanged =
      cfg.map.styleLight !== this.cfg.map.styleLight ||
      cfg.map.styleDark !== this.cfg.map.styleDark;
    this.cfg = cfg;
    if (styleChanged) this.setStyleFor(this.theme.dark);
    if (cfg.map.graticule !== this.graticuleOn) this.setGraticule(cfg.map.graticule);
    this.dirty = true;
  }

  // ----------------------------------------------------------------- style

  private styleUrl(dark: boolean): string {
    return dark ? this.cfg.map.styleDark : this.cfg.map.styleLight;
  }

  private offlineStyle(): StyleSpecification {
    return {
      version: 8,
      name: 'offline',
      sources: {},
      layers: [
        { id: 'background', type: 'background', paint: { 'background-color': this.palette.bg } },
      ],
    };
  }

  private setStyleFor(dark: boolean): void {
    this.styleReady = false;
    this.emit('style-status', 'loading');
    this.map.setStyle(this.styleUrl(dark), { diff: false });
    this.armStyleTimeout();
  }

  /** If the remote style has not arrived after a few seconds, draw on a plain background. */
  private armStyleTimeout(): void {
    if (this.styleTimer) clearTimeout(this.styleTimer);
    this.styleTimer = setTimeout(() => {
      if (!this.styleReady) {
        console.warn('Map style slow or unreachable, drawing the ride on a plain background');
        this.emit('style-status', 'offline');
        this.map.setStyle(this.offlineStyle());
      }
    }, 8000);
  }

  private onError(e: { error?: { message?: string; status?: number } }): void {
    const msg = e.error?.message ?? '';
    // A style that cannot be fetched (offline) leaves the map empty; fall back
    // to a plain background so the ride layers still draw.
    if (
      !this.styleReady &&
      (msg.includes('style') ||
        msg.includes('Failed to fetch') ||
        msg.includes('NetworkError') ||
        e.error?.status)
    ) {
      if (!this.map.getStyle()?.layers?.length) {
        console.warn('Map style unreachable, drawing the ride on a plain background');
        this.emit('style-status', 'offline');
        this.map.setStyle(this.offlineStyle());
      }
    }
  }

  private onStyleLoad(): void {
    this.installLayers();
    this.styleReady = true;
    this.dirty = true;
    this.refresh(true);
    if (this.graticuleOn) this.updateGraticule();
    const name = this.map.getStyle()?.name;
    this.emit('style-status', name === 'offline' ? 'offline' : 'ready');
  }

  private conditionColourExpr(): ExpressionSpecification {
    const pairs: (string | ExpressionSpecification)[] = [];
    for (const [id, colour] of Object.entries(this.palette.conditions)) pairs.push(id, colour);
    return [
      'match',
      ['get', 'label'],
      ...pairs,
      this.palette.unknown,
    ] as unknown as ExpressionSpecification;
  }

  private installLayers(): void {
    const map = this.map;
    const p = this.palette;
    const addSource = (id: string, data: GeoJSON.GeoJSON) => {
      if (!map.getSource(id)) map.addSource(id, { type: 'geojson', data });
    };
    addSource('hex', this.hexData);
    addSource('ride', EMPTY_FC);
    addSource('bumps', EMPTY_FC);
    addSource('highlight', EMPTY_FC);
    addSource('graticule', EMPTY_FC);
    addSource('graticule-labels', EMPTY_FC);

    // Zoom expressions must be top-level, so scaled widths get their own stops.
    const zoomWidth = (factor: number): ExpressionSpecification =>
      [
        'interpolate',
        ['exponential', 1.6],
        ['zoom'],
        11,
        1.6 * factor,
        14,
        4 * factor,
        17,
        9 * factor,
        19,
        16 * factor,
      ] as unknown as ExpressionSpecification;
    const width = zoomWidth(1);
    const casingWidth = zoomWidth(1.9);
    const lowOpacity: ExpressionSpecification = ['case', ['==', ['get', 'low'], 1], 0.4, 1];

    // Aggregated quality layer (under the ride).
    map.addLayer({
      id: 'hex-fill',
      type: 'fill',
      source: 'hex',
      layout: { visibility: this.aggregateOn ? 'visible' : 'none' },
      paint: {
        'fill-color': [
          'interpolate',
          ['linear'],
          ['get', 'comfort'],
          0,
          p.conditions.bump ?? p.unknown,
          50,
          p.conditions.rough ?? p.unknown,
          100,
          p.conditions.smooth ?? p.unknown,
        ],
        'fill-opacity': ['interpolate', ['linear'], ['get', 'count'], 1, 0.35, 8, 0.6],
      },
    });
    map.addLayer({
      id: 'hex-line',
      type: 'line',
      source: 'hex',
      layout: { visibility: this.aggregateOn ? 'visible' : 'none' },
      paint: { 'line-color': p.halo, 'line-width': 0.6, 'line-opacity': 0.6 },
    });

    // Graticule.
    map.addLayer({
      id: 'graticule-lines',
      type: 'line',
      source: 'graticule',
      layout: { visibility: this.graticuleOn ? 'visible' : 'none' },
      paint: {
        'line-color': p.ink3,
        'line-width': 0.9,
        'line-opacity': 0.7,
        'line-dasharray': [4, 3],
      },
    });
    map.addLayer({
      id: 'graticule-text',
      type: 'symbol',
      source: 'graticule-labels',
      layout: {
        visibility: this.graticuleOn ? 'visible' : 'none',
        'text-field': ['get', 'label'],
        'text-size': 10,
        'text-font': ['Open Sans Regular', 'Arial Unicode MS Regular'],
        'text-anchor': ['get', 'anchor'],
        'text-offset': [0.4, 0.4],
        'text-allow-overlap': true,
      },
      paint: { 'text-color': p.ink3, 'text-halo-color': p.halo, 'text-halo-width': 1 },
    });

    // Ride ribbon: casing, coloured line, pattern overlays.
    map.addLayer({
      id: 'ride-casing',
      type: 'line',
      source: 'ride',
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: {
        'line-color': p.casing,
        'line-width': casingWidth,
        'line-opacity': ['case', ['==', ['get', 'low'], 1], 0.25, 0.8],
      },
    });
    map.addLayer({
      id: 'ride-line',
      type: 'line',
      source: 'ride',
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: {
        'line-color': this.conditionColourExpr(),
        'line-width': width,
        'line-opacity': lowOpacity,
      },
    });
    // Rough: a hatched overlay (pale stripes across the ribbon).
    map.addLayer({
      id: 'ride-rough-hatch',
      type: 'line',
      source: 'ride',
      filter: ['==', ['get', 'pattern'], 'hatched'],
      layout: { 'line-cap': 'butt', 'line-join': 'round' },
      paint: {
        'line-color': p.halo,
        'line-width': width,
        'line-dasharray': [0.6, 1.1],
        'line-opacity': ['case', ['==', ['get', 'low'], 1], 0.3, 0.7],
      },
    });
    // Stopped: hollow (an inner line in the background colour).
    map.addLayer({
      id: 'ride-stopped-hollow',
      type: 'line',
      source: 'ride',
      filter: ['==', ['get', 'pattern'], 'hollow'],
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-color': p.bg, 'line-width': zoomWidth(0.45), 'line-opacity': 0.95 },
    });
    // Low confidence: dotted overlay on top of the faint line.
    map.addLayer({
      id: 'ride-low-dots',
      type: 'line',
      source: 'ride',
      filter: ['any', ['==', ['get', 'low'], 1], ['==', ['get', 'pattern'], 'dotted']],
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: {
        'line-color': this.conditionColourExpr(),
        'line-width': zoomWidth(0.5),
        'line-dasharray': [0.1, 1.8],
        'line-opacity': 0.9,
      },
    });

    // Street highlight (area report).
    map.addLayer({
      id: 'highlight-halo',
      type: 'line',
      source: 'highlight',
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: {
        'line-color': p.accent,
        'line-width': zoomWidth(3.2),
        'line-opacity': 0.35,
        'line-blur': 2,
      },
    });

    // Bump pins.
    this.ensurePinImages();
    map.addLayer({
      id: 'bump-pins',
      type: 'symbol',
      source: 'bumps',
      layout: {
        'icon-image': ['case', ['==', ['get', 'low'], 1], 'pin-bump-low', 'pin-bump'],
        'icon-size': ['interpolate', ['linear'], ['zoom'], 12, 0.45, 16, 0.8, 19, 1],
        'icon-anchor': 'bottom',
        'icon-allow-overlap': true,
        'icon-ignore-placement': true,
      },
    });
  }

  private ensurePinImages(): void {
    const colour = this.palette.conditions.bump ?? this.palette.unknown;
    for (const [name, alpha] of [
      ['pin-bump', 1],
      ['pin-bump-low', 0.45],
    ] as const) {
      if (this.map.hasImage(name)) this.map.removeImage(name);
      this.map.addImage(name, drawPin(colour, this.palette.halo, alpha), { pixelRatio: 2 });
    }
  }

  // ----------------------------------------------------------------- data

  markDirty(): void {
    this.dirty = true;
  }

  /** Pushes the store state to the map sources. Throttled to ~4 Hz unless forced. */
  refresh(force = false): void {
    if (!this.styleReady) return;
    const now = performance.now();
    if (!force && (!this.dirty || now - this.lastRefresh < 250)) return;
    this.dirty = false;
    this.lastRefresh = now;
    const upTo = this.store.viewTs;
    (this.map.getSource('ride') as maplibregl.GeoJSONSource | undefined)?.setData(
      rideCollection(this.store, upTo),
    );
    (this.map.getSource('bumps') as maplibregl.GeoJSONSource | undefined)?.setData(
      bumpCollection(this.store, upTo),
    );
  }

  setHexData(data: GeoJSON.FeatureCollection<GeoJSON.Polygon, HexProps>): void {
    this.hexData = data;
    (this.map.getSource('hex') as maplibregl.GeoJSONSource | undefined)?.setData(data);
  }

  setAggregate(on: boolean): void {
    this.aggregateOn = on;
    if (!this.styleReady) return;
    for (const id of ['hex-fill', 'hex-line'])
      this.map.setLayoutProperty(id, 'visibility', on ? 'visible' : 'none');
  }

  // ----------------------------------------------------------------- markers

  private clearMarkers(): void {
    for (const m of this.markers.values()) m.marker.remove();
    this.markers.clear();
    this.lastEaseTarget = null;
  }

  private markerFor(d: DeviceState): MarkerState {
    let m = this.markers.get(d.id);
    if (m) return m;
    const arrow = el('div', { class: 'bike-marker-arrow' });
    arrow.innerHTML =
      '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3 L19 20 L12 16 L5 20 Z" fill="currentColor"/></svg>';
    const node = el('div', { class: 'bike-marker motion', 'data-device': d.id, title: d.id }, [
      el('div', { class: 'bike-marker-pulse' }),
      el('div', { class: 'bike-marker-dot' }, [arrow]),
      el('div', { class: 'bike-marker-tag t-label', text: d.id }),
    ]);
    node.style.setProperty('--bike', this.palette.bikes[(d.slot - 1) % 4] ?? this.palette.accent);
    node.addEventListener('click', (e) => {
      e.stopPropagation();
      this.store.select(d.id);
    });
    const marker = new maplibregl.Marker({
      element: node,
      anchor: 'center',
      pitchAlignment: 'map',
      rotationAlignment: 'map',
    });
    m = { marker, el: node, arrow, from: [0, 0], to: [0, 0], heading: 0, startedAt: 0, label: '' };
    this.markers.set(d.id, m);
    return m;
  }

  /** Called every animation frame: moves markers and refreshes data when due. */
  frame(now: number): void {
    this.refresh();
    const t = this.store.viewTs;
    for (const d of this.store.devices.values()) {
      const pos = this.store.positionAt(d, t);
      if (!pos) continue;
      const m = this.markerFor(d);
      const target: LonLat = [pos.lon, pos.lat];
      if (m.startedAt === 0) {
        m.from = target;
        m.to = target;
        m.startedAt = now;
        m.marker.setLngLat(target).addTo(this.map);
      } else if (m.to[0] !== target[0] || m.to[1] !== target[1]) {
        m.from = this.currentMarkerPos(m, now);
        m.to = target;
        m.startedAt = now;
      }
      const cur = this.currentMarkerPos(m, now);
      m.marker.setLngLat(cur);
      const heading = pos.heading ?? m.heading;
      m.heading += bearingDelta(m.heading, heading) * 0.2;
      m.arrow.style.transform = `rotate(${m.heading}deg)`;
      const sample = this.store.sampleAt(d, t);
      const label = sample?.label ?? 'unknown';
      if (label !== m.label) {
        m.label = label;
        m.el.dataset.label = label;
        m.el.style.setProperty('--cond', this.palette.conditions[label] ?? this.palette.unknown);
      }
      m.el.classList.toggle('is-selected', d.id === this.store.selectedId);
      m.el.classList.toggle('is-stopped', label === 'stopped');
    }
  }

  private currentMarkerPos(m: MarkerState, now: number): LonLat {
    const dur = this.motion() > 0 ? 1000 : 0;
    const f = dur ? clamp((now - m.startedAt) / dur, 0, 1) : 1;
    return [m.from[0] + (m.to[0] - m.from[0]) * f, m.from[1] + (m.to[1] - m.from[1]) * f];
  }

  /** A short expanding ring where a bump was detected. */
  private ripple(p: LonLat): void {
    const node = el('div', { class: 'bump-ripple motion' });
    node.style.setProperty('--cond', this.palette.conditions.bump ?? this.palette.unknown);
    const marker = new maplibregl.Marker({ element: node, anchor: 'center' })
      .setLngLat(p)
      .addTo(this.map);
    setTimeout(() => marker.remove(), 1300);
  }

  showGhost(ts: number | null): void {
    const d = this.store.selected;
    const pos = d && ts != null ? this.store.positionAt(d, ts) : null;
    if (!pos) {
      this.ghost?.remove();
      this.ghost = null;
      return;
    }
    if (!this.ghost) {
      this.ghost = new maplibregl.Marker({
        element: el('div', { class: 'ghost-marker' }),
        anchor: 'center',
      });
    }
    this.ghost.setLngLat([pos.lon, pos.lat]).addTo(this.map);
  }

  // ----------------------------------------------------------------- hover

  private hoverRide(point: maplibregl.PointLike): void {
    if (!this.styleReady || !this.map.getLayer('ride-line')) return;
    const features = this.map.queryRenderedFeatures(point, { layers: ['ride-line', 'bump-pins'] });
    const f = features[0];
    if (!f) {
      this.clearHover();
      return;
    }
    const props = f.properties as {
      device: string;
      label: string;
      t0?: number;
      t1?: number;
      ts?: number;
      confidence?: number;
    };
    const ts = props.ts ?? props.t1 ?? props.t0 ?? 0;
    const key = `${props.device}:${props.label}:${ts}`;
    if (key !== this.hoverFeatureKey) {
      this.hoverFeatureKey = key;
      this.map.getCanvas().style.cursor = 'pointer';
      const time = new Date(ts);
      const hhmm = [time.getHours(), time.getMinutes(), time.getSeconds()]
        .map((n) => String(n).padStart(2, '0'))
        .join(':');
      this.popup
        .setHTML(
          `<span class="ride-popup-label" style="--c:${this.palette.conditions[props.label] ?? this.palette.unknown}">${props.label}</span>` +
            `<span class="t-num">${props.device} ${hhmm}</span>` +
            (props.confidence != null
              ? `<span class="t-num">${Math.round(props.confidence * 100)}%</span>`
              : ''),
        )
        .addTo(this.map);
      this.emit('hover-sample', { ts, device: props.device, label: props.label });
    }
    const ll = this.map.unproject(point);
    this.popup.setLngLat(ll);
  }

  private clearHover(): void {
    if (!this.hoverFeatureKey) return;
    this.hoverFeatureKey = '';
    this.map.getCanvas().style.cursor = '';
    this.popup.remove();
    this.emit('hover-sample', null);
  }

  // ----------------------------------------------------------------- camera

  setFollow(on: boolean): void {
    if (this.follow === on) return;
    this.follow = on;
    this.emit('follow', on);
    if (on) this.followNow(true);
  }

  setHeadingUp(on: boolean): void {
    this.headingUp = on;
    if (this.follow) this.followNow(true);
    else this.ease({ bearing: 0 });
  }

  /** Eases the camera towards the selected bike. Call once per new fix. */
  followNow(immediate = false): void {
    if (!this.follow) return;
    const d = this.store.selected;
    if (!d) return;
    const pos = this.store.positionAt(d, this.store.viewTs);
    if (!pos) return;
    const speed = pos.speed ?? this.store.sampleAt(d, this.store.viewTs)?.speed ?? 0;
    const f = clamp(speed / 22, 0, 1);
    const targetZoom =
      this.cfg.map.followZoomSlow + (this.cfg.map.followZoomFast - this.cfg.map.followZoomSlow) * f;
    this.zoomEma = immediate ? targetZoom : this.zoomEma * 0.85 + targetZoom * 0.15;
    const target: LonLat = [pos.lon, pos.lat];
    if (
      !immediate &&
      this.lastEaseTarget &&
      this.lastEaseTarget[0] === target[0] &&
      this.lastEaseTarget[1] === target[1]
    )
      return;
    this.lastEaseTarget = target;
    const bearing = this.headingUp ? (pos.heading ?? this.map.getBearing()) : 0;
    const motion = this.motion();
    this.ease({
      center: target,
      zoom: this.zoomEma,
      bearing,
      pitch: motion > 0 ? this.cfg.map.followPitch : 0,
      duration: immediate ? 600 : motion > 0 ? 1000 : 0,
      ...(immediate ? {} : { easing: (t: number) => t }),
    });
  }

  private ease(opts: maplibregl.EaseToOptions): void {
    this.suppressInteraction++;
    this.map.easeTo({ essential: true, ...opts });
    // The programmatic movement emits movestart synchronously; release after.
    this.suppressInteraction--;
  }

  /** Fits the whole ride into view. */
  fitRide(): void {
    const bounds = new maplibregl.LngLatBounds();
    let n = 0;
    for (const d of this.store.devices.values()) {
      for (const f of d.gps.all()) {
        bounds.extend([f.lon, f.lat]);
        n++;
      }
      for (const s of d.samples) if (s.pos) bounds.extend([s.pos.lon, s.pos.lat]);
    }
    this.setFollow(false);
    if (!n && bounds.isEmpty()) return this.resetView();
    this.suppressInteraction++;
    this.map.fitBounds(bounds, {
      padding: 60,
      pitch: 0,
      bearing: 0,
      duration: this.motion() > 0 ? 900 : 0,
      maxZoom: 16.5,
    });
    this.suppressInteraction--;
  }

  resetView(): void {
    this.setFollow(false);
    this.ease({
      center: this.cfg.map.center,
      zoom: this.cfg.map.zoom,
      pitch: 0,
      bearing: 0,
      duration: this.motion() > 0 ? 900 : 0,
    });
  }

  /** Flies to the position at a time (timeline click). Pauses follow. */
  flyToTime(ts: number): void {
    const d = this.store.selected;
    const pos = d ? this.store.positionAt(d, ts) : null;
    if (!pos) return;
    this.setFollow(false);
    this.suppressInteraction++;
    this.map.flyTo({
      center: [pos.lon, pos.lat],
      zoom: Math.max(this.map.getZoom(), 16.5),
      duration: this.motion() > 0 ? 900 : 0,
      essential: true,
    });
    this.suppressInteraction--;
  }

  /** Opening sequence: from a city-wide view down onto the bike. */
  introFlight(onDone: () => void): void {
    const d = this.store.selected;
    const pos = d ? this.store.positionAt(d, null) : null;
    if (!pos || this.motion() === 0) {
      this.followNow(true);
      onDone();
      return;
    }
    this.map.jumpTo({
      center: [pos.lon + 0.004, pos.lat + 0.002],
      zoom: 11.6,
      pitch: 0,
      bearing: -20,
    });
    this.suppressInteraction++;
    this.map.flyTo({
      center: [pos.lon, pos.lat],
      zoom: this.cfg.map.followZoomSlow,
      pitch: this.cfg.map.followPitch,
      bearing: 0,
      duration: 3800,
      curve: 1.4,
      essential: true,
    });
    this.suppressInteraction--;
    this.map.once('moveend', () => {
      this.follow = true;
      this.emit('follow', true);
      this.followNow(true);
      onDone();
    });
  }

  // ----------------------------------------------------------------- highlight

  highlightStreet(report: StreetReport | null): void {
    const src = this.map.getSource('highlight') as maplibregl.GeoJSONSource | undefined;
    if (!src) return;
    if (!report) {
      src.setData(EMPTY_FC);
      return;
    }
    src.setData({
      type: 'FeatureCollection',
      features: [
        {
          type: 'Feature',
          properties: {},
          geometry: { type: 'MultiLineString', coordinates: report.segments.map((s) => s.coords) },
        },
      ],
    });
    this.setFollow(false);
    this.suppressInteraction++;
    this.map.fitBounds(report.bounds as LngLatBoundsLike, {
      padding: 90,
      maxZoom: 17.5,
      duration: this.motion() > 0 ? 800 : 0,
    });
    this.suppressInteraction--;
  }

  // ----------------------------------------------------------------- graticule

  setGraticule(on: boolean): void {
    this.graticuleOn = on;
    if (!this.styleReady) return;
    for (const id of ['graticule-lines', 'graticule-text'])
      this.map.setLayoutProperty(id, 'visibility', on ? 'visible' : 'none');
    if (on) this.updateGraticule();
  }

  private updateGraticule(): void {
    const b = this.map.getBounds();
    const span = Math.max(b.getEast() - b.getWest(), b.getNorth() - b.getSouth());
    const steps = [2, 1, 0.5, 0.25, 0.1, 0.05, 0.02, 0.01, 0.005, 0.002, 0.001, 0.0005];
    // The finest spacing that still gives at most about seven lines across the view.
    const step = [...steps].reverse().find((s) => span / s <= 7) ?? 2;
    const lines: GeoJSON.Feature[] = [];
    const labels: GeoJSON.Feature[] = [];
    const fmt = (v: number) => v.toFixed(Math.max(0, -Math.floor(Math.log10(step))) + 0);
    for (let lon = Math.floor(b.getWest() / step) * step; lon <= b.getEast(); lon += step) {
      lines.push({
        type: 'Feature',
        properties: {},
        geometry: {
          type: 'LineString',
          coordinates: [
            [lon, b.getSouth()],
            [lon, b.getNorth()],
          ],
        },
      });
      labels.push({
        type: 'Feature',
        properties: { label: `${fmt(lon)}°E`, anchor: 'top-left' },
        geometry: { type: 'Point', coordinates: [lon, b.getNorth()] },
      });
    }
    for (let lat = Math.floor(b.getSouth() / step) * step; lat <= b.getNorth(); lat += step) {
      lines.push({
        type: 'Feature',
        properties: {},
        geometry: {
          type: 'LineString',
          coordinates: [
            [b.getWest(), lat],
            [b.getEast(), lat],
          ],
        },
      });
      labels.push({
        type: 'Feature',
        properties: { label: `${fmt(lat)}°N`, anchor: 'top-left' },
        geometry: { type: 'Point', coordinates: [b.getWest(), lat] },
      });
    }
    (this.map.getSource('graticule') as maplibregl.GeoJSONSource | undefined)?.setData({
      type: 'FeatureCollection',
      features: lines,
    });
    (this.map.getSource('graticule-labels') as maplibregl.GeoJSONSource | undefined)?.setData({
      type: 'FeatureCollection',
      features: labels,
    });
  }

  // ----------------------------------------------------------------- snapshot

  /** PNG of the map canvas with the bike markers and a legend drawn on top. */
  snapshot(title: string, legend: { id: string; name: string; pattern: string }[]): Promise<Blob> {
    return new Promise((resolve, reject) => {
      this.map.once('render', () => {
        try {
          const src = this.map.getCanvas();
          const out = document.createElement('canvas');
          out.width = src.width;
          out.height = src.height;
          const ctx = out.getContext('2d')!;
          const dpr = src.width / src.clientWidth;
          ctx.drawImage(src, 0, 0);
          ctx.scale(dpr, dpr);
          const p = this.palette;

          // Bike markers.
          for (const m of this.markers.values()) {
            const ll = m.marker.getLngLat();
            const pt = this.map.project(ll);
            ctx.save();
            ctx.translate(pt.x, pt.y);
            ctx.fillStyle = m.el.style.getPropertyValue('--bike') || p.accent;
            ctx.strokeStyle = p.halo;
            ctx.lineWidth = 3;
            ctx.beginPath();
            ctx.arc(0, 0, 9, 0, Math.PI * 2);
            ctx.fill();
            ctx.stroke();
            ctx.rotate((m.heading * Math.PI) / 180);
            ctx.fillStyle = p.halo;
            ctx.beginPath();
            ctx.moveTo(0, -6);
            ctx.lineTo(4, 4);
            ctx.lineTo(0, 2);
            ctx.lineTo(-4, 4);
            ctx.closePath();
            ctx.fill();
            ctx.restore();
          }

          // Legend box.
          const w = 190;
          const rowH = 20;
          const h = 34 + legend.length * rowH;
          const x = 14;
          const y = src.clientHeight - h - 40;
          ctx.fillStyle = withAlpha(p.surface, 0.92);
          ctx.strokeStyle = p.line;
          ctx.lineWidth = 1;
          ctx.fillRect(x, y, w, h);
          ctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
          ctx.fillStyle = p.ink;
          ctx.font = `600 14px ${p.fontDisplay}`;
          ctx.fillText(title.toUpperCase(), x + 12, y + 20);
          legend.forEach((item, i) => {
            const ry = y + 34 + i * rowH;
            const colour = p.conditions[item.id] ?? p.unknown;
            ctx.strokeStyle = colour;
            ctx.lineWidth = 6;
            ctx.setLineDash(
              item.pattern === 'hatched' ? [3, 3] : item.pattern === 'dotted' ? [1, 4] : [],
            );
            ctx.beginPath();
            ctx.moveTo(x + 12, ry);
            ctx.lineTo(x + 40, ry);
            ctx.stroke();
            if (item.pattern === 'hollow') {
              ctx.strokeStyle = withAlpha(p.surface, 0.92);
              ctx.lineWidth = 2.5;
              ctx.setLineDash([]);
              ctx.beginPath();
              ctx.moveTo(x + 13, ry);
              ctx.lineTo(x + 39, ry);
              ctx.stroke();
            }
            if (item.pattern === 'pin') {
              ctx.setLineDash([]);
              ctx.fillStyle = colour;
              ctx.beginPath();
              ctx.arc(x + 26, ry - 2, 5, 0, Math.PI * 2);
              ctx.fill();
              ctx.beginPath();
              ctx.moveTo(x + 21.5, ry);
              ctx.lineTo(x + 26, ry + 7);
              ctx.lineTo(x + 30.5, ry);
              ctx.fill();
            }
            ctx.setLineDash([]);
            ctx.fillStyle = p.ink2;
            ctx.font = `12px ${p.fontText}`;
            ctx.fillText(item.name, x + 50, ry + 4);
          });
          ctx.fillStyle = p.ink3;
          ctx.font = `10px ${p.fontText}`;
          ctx.fillText('Map data: OpenStreetMap contributors, CARTO', x, src.clientHeight - 10);
          out.toBlob(
            (blob) => (blob ? resolve(blob) : reject(new Error('Snapshot failed'))),
            'image/png',
          );
        } catch (err) {
          reject(err instanceof Error ? err : new Error(String(err)));
        }
      });
      this.map.triggerRepaint();
    });
  }
}

/** Draws a bump pin (teardrop with a centre dot) as ImageData for a symbol layer. */
function drawPin(colour: string, halo: string, alpha: number): ImageData {
  const w = 48;
  const h = 64;
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d')!;
  ctx.globalAlpha = alpha;
  ctx.translate(w / 2, h - 4);
  ctx.beginPath();
  ctx.moveTo(0, 0);
  ctx.bezierCurveTo(-18, -22, -20, -30, -20, -36);
  ctx.arc(0, -36, 20, Math.PI, 0, false);
  ctx.bezierCurveTo(20, -30, 18, -22, 0, 0);
  ctx.closePath();
  ctx.fillStyle = colour;
  ctx.fill();
  ctx.lineWidth = 3;
  ctx.strokeStyle = halo;
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(0, -36, 7, 0, Math.PI * 2);
  ctx.fillStyle = halo;
  ctx.fill();
  return ctx.getImageData(0, 0, w, h);
}

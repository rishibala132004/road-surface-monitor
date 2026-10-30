/**
 * Application entry point: loads the configuration, builds the store, the
 * data sources, the map and every component, then runs one animation frame
 * loop that drives all continuous updates.
 */
import '@fontsource/saira-condensed/500.css';
import '@fontsource/saira-condensed/600.css';
import '@fontsource/saira-condensed/700.css';
import '@fontsource/public-sans/400.css';
import '@fontsource/public-sans/500.css';
import '@fontsource/public-sans/600.css';
import '@fontsource/jetbrains-mono/400.css';
import '@fontsource/jetbrains-mono/500.css';
import './styles/tokens.css';
import './styles/base.css';
import './styles/layout.css';
import './styles/map.css';
import './styles/rail.css';
import './styles/cyclist.css';
import './styles/timeline.css';
import './styles/chrome.css';

import { config } from './config';
import { RideStore } from './data/store';
import { SourceManager } from './data/sources/SourceManager';
import { MapController } from './map/map';
import { Geocoder } from './map/geocode';
import { ThemeManager } from './components/theme';
import { Header } from './components/header';
import { MapOverlays } from './components/overlays';
import { Rail } from './components/readouts';
import { Timeline } from './components/timeline';
import { AreaReport } from './components/areaReport';
import { PipelineView } from './components/pipeline';
import { SettingsDrawer } from './components/settings';
import { SourceDrawer } from './components/connect';
import { ExportDrawer } from './components/exports';
import { RawSignalDrawer } from './components/rawSignal';
import { HelpDrawer, installShortcuts } from './components/shortcuts';
import { Toasts } from './components/toast';
import { Drawer } from './components/drawer';
import { playIntro } from './components/intro';
import { $ } from './utils/dom';
import type { LonLat } from './utils/geo';

async function boot(): Promise<void> {
  const cfg = await config.load();
  document.title = cfg.title;

  const theme = new ThemeManager();
  theme.configure(cfg);

  const store = new RideStore(cfg);
  const sources = new SourceManager(store, cfg, import.meta.env.BASE_URL);
  const toasts = new Toasts($('#toasts'));
  const geocoder = new Geocoder(cfg.geocoding);

  // Street names for the simulator route, so the area report works offline.
  void fetch(`${import.meta.env.BASE_URL}${cfg.simulator.routeUrl}`)
    .then((r) => r.json())
    .then(
      (gj: {
        features?: {
          geometry?: { coordinates?: LonLat[] };
          properties?: { streets?: { name: string; from_m: number; to_m: number }[] };
        }[];
      }) => {
        const f = gj.features?.[0];
        if (f?.geometry?.coordinates)
          geocoder.setRoute(f.geometry.coordinates, f.properties?.streets ?? []);
      },
    )
    .catch(() => undefined);

  const map = new MapController($('#map'), cfg, theme, store);
  if (import.meta.env.DEV) {
    // Handy in the browser console during development: __rsm.store, __rsm.map.map
    (window as unknown as { __rsm: unknown }).__rsm = { map, store, sources };
  }
  const overlays = new MapOverlays($('#map-overlays'), store, map, geocoder, cfg, (on) => {
    map.setAggregate(on);
    overlays.setHexPressed(on);
    if (on) report.refreshHex(true);
  });
  const rail = new Rail($('#rail'), store, theme, cfg);
  const report = new AreaReport($('#rail'), store, map, geocoder, cfg);
  const timeline = new Timeline($('#timeline'), store, theme, cfg, {
    onHover: (ts) => map.showGhost(ts),
    onClick: (ts) => map.flyToTime(ts),
  });
  const drawers = $('#drawers');
  const pipeline = new PipelineView(
    drawers,
    store,
    () => theme.motionScale,
    () => togglePipeline(false),
  );
  const settings = new SettingsDrawer(drawers, config, toasts, (patch) => {
    if (patch.speed != null) sources.sim.setSpeed(patch.speed);
    if (patch.secondBike != null) sources.sim.setSecondBike(patch.secondBike);
    sourceDrawer.syncSimSpeed();
  });
  const sourceDrawer = new SourceDrawer(drawers, config, sources, toasts);
  const exportsDrawer = new ExportDrawer(drawers, store, map, cfg, toasts);
  const signals = new RawSignalDrawer(
    drawers,
    theme,
    (label) => theme.palette.conditions[label] ?? theme.palette.unknown,
  );
  const help = new HelpDrawer(drawers, cfg.title, cfg.team, cfg.course, cfg.repoUrl);

  let presentation = false;
  const togglePresentation = (force?: boolean) => {
    presentation = force ?? !presentation;
    document.documentElement.dataset.presentation = String(presentation);
    header.setPressed('present', presentation);
    setTimeout(() => map.map.resize(), 50);
  };
  const toggleFullscreen = () => {
    if (!document.fullscreenElement) {
      void document.documentElement.requestFullscreen?.().then(() => togglePresentation(true));
    } else void document.exitFullscreen();
  };
  document.addEventListener('fullscreenchange', () => {
    if (!document.fullscreenElement && presentation) togglePresentation(false);
  });
  const togglePipeline = (force?: boolean) => {
    pipeline.toggle(force);
    header.setPressed('pipeline', pipeline.isOpen);
  };

  const header = new Header($('#topbar'), store, cfg, {
    onConnect: () => sourceDrawer.drawer.toggle(),
    onPipeline: () => togglePipeline(),
    onSignals: () => signals.drawer.toggle(),
    onExport: () => exportsDrawer.open(),
    onTheme: () => config.update({ theme: theme.next() }),
    onPresent: () => togglePresentation(),
    onSettings: () => settings.drawer.toggle(),
    onHelp: () => help.drawer.toggle(),
  });
  header.setThemeIcon(theme.dark);
  for (const [name, d] of [
    ['settings', settings.drawer],
    ['signals', signals.drawer],
  ] as const) {
    d.onClose(() => header.setPressed(name, false));
  }
  const origShow = settings.drawer.show.bind(settings.drawer);
  settings.drawer.show = () => {
    origShow();
    header.setPressed('settings', true);
  };
  const origShowSignals = signals.drawer.show.bind(signals.drawer);
  signals.drawer.show = () => {
    origShowSignals();
    header.setPressed('signals', true);
  };

  // ---------------------------------------------------------------- wiring
  config.on('change', (c) => {
    theme.configure(c);
    store.setConfig(c);
    sources.setConfig(c);
    geocoder.setConfig(c.geocoding);
    map.setConfig(c);
    overlays.setConfig(c);
    rail.setConfig(c);
    report.setConfig(c);
    timeline.setConfig(c);
    header.setConfig(c);
    exportsDrawer.setConfig(c);
    header.setThemeIcon(theme.dark);
    map.markDirty();
  });

  const app = $('#app');
  sources.on('switching', ({ from, to }) => {
    report.archiveCurrent();
    if (theme.motionScale > 0 && from === 'simulated' && to === 'live') {
      app.classList.add('is-switching');
      setTimeout(() => app.classList.remove('is-switching'), 700);
    }
  });
  sources.on('switched', ({ kind, device }) => {
    header.setSource(kind);
    overlays.showBanner(null);
    if (kind === 'live') toasts.show(`Live data from ${device ?? 'the bike'}`, 'ok', 5000);
    else if (kind === 'simulated') toasts.show('Simulation', 'info');
    map.setFollow(true);
  });
  sources.on('mqtt', ({ status, detail }) => {
    const state =
      status === 'running'
        ? 'on'
        : status === 'starting'
          ? 'connecting'
          : status === 'offline'
            ? 'offline'
            : status === 'error'
              ? 'error'
              : 'off';
    header.setConnection(state, detail);
    if (status === 'running' && store.sourceKind === 'simulated')
      header.setDetail('broker connected, waiting for the first result');
    else if (status === 'offline' && store.sourceKind === 'live')
      overlays.showBanner('Broker offline, reconnecting', 'warn');
    else if (status === 'running' && store.sourceKind === 'live') {
      overlays.showBanner(null);
      header.setDetail('');
    } else if (status === 'idle') header.setDetail('');
  });
  sources.on('stale', ({ stale, sinceMs }) => {
    overlays.showBanner(stale ? `No data for ${Math.floor(sinceMs / 1000)} s` : null, 'danger');
  });
  store.on('gps', ({ device }) => {
    if (device.id === store.selectedId && store.isLive) map.followNow();
    map.markDirty();
  });
  store.on('condition', () => map.markDirty());
  store.on('device-selected', () => {
    map.markDirty();
    map.followNow(true);
  });
  store.on('view', () => {
    map.markDirty();
    if (map.follow) map.followNow(true);
  });
  store.on('reset', () => map.markDirty());
  map.on('hover-sample', (h) => {
    const d = store.selected;
    timeline.externalHover(h && d ? store.sampleAt(d, h.ts) : null);
  });
  map.on('follow', () => undefined);
  const origHeading = map.setHeadingUp.bind(map);
  map.setHeadingUp = (on) => {
    origHeading(on);
    overlays.setHeadingPressed(on);
  };
  const origGrid = map.setGraticule.bind(map);
  map.setGraticule = (on) => {
    origGrid(on);
    overlays.setGridPressed(on);
  };

  installShortcuts({
    fullscreen: toggleFullscreen,
    theme: () => config.update({ theme: theme.next() }),
    pipeline: () => togglePipeline(),
    overview: () => map.fitRide(),
    playPause: () => {
      if (store.sourceKind === 'simulated' && store.isLive && !timeline.isPlaying) {
        sources.sim.setPaused(!sources.sim.isPaused);
        toasts.show(
          sources.sim.isPaused ? 'Simulation paused' : 'Simulation running',
          'info',
          1500,
        );
      } else if (store.sourceKind === 'replay' && store.isLive && sources.replay) {
        sources.replay.setPaused(!sources.replay.isPaused);
        toasts.show(sources.replay.isPaused ? 'Replay paused' : 'Replay running', 'info', 1500);
      } else timeline.togglePlay();
    },
    reset: () => {
      sources.resetRide();
      toasts.show('Ride reset', 'info', 1500);
    },
    selectBike: (i) => {
      const d = store.deviceList[i];
      if (d) store.select(d.id);
    },
    help: () => help.drawer.toggle(),
    escape: () => {
      if (pipeline.isOpen) togglePipeline(false);
      else if (!Drawer.closeAny() && store.viewTs != null) timeline.goLive();
    },
  });

  // ---------------------------------------------------------------- start
  header.setSource('simulated');
  await sources.useSimulation();
  sourceDrawer.autoConnect();

  let last = performance.now();
  const frame = (now: number) => {
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;
    map.frame(now);
    rail.frame(now, dt);
    timeline.frame(now);
    overlays.frame(now);
    report.frame(now);
    pipeline.frame(now);
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);

  const skipIntro =
    new URLSearchParams(location.search).has('nointro') ||
    sessionStorage.getItem('rsm.intro') === '1';
  sessionStorage.setItem('rsm.intro', '1');
  if (skipIntro) {
    map.followNow(true);
  } else {
    await playIntro(
      $('#intro'),
      cfg.title,
      'University of Twente campus to the city centre, live from the bike',
      theme.motionScale,
      (done) => map.introFlight(done),
    );
  }
}

boot().catch((err) => {
  console.error(err);
  const msg = document.createElement('pre');
  msg.textContent = `The dashboard could not start: ${err instanceof Error ? err.message : String(err)}`;
  msg.style.padding = '2rem';
  document.body.replaceChildren(msg);
});

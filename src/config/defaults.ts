/**
 * Built-in fallback configuration. The deployed defaults are read from
 * `public/config.json`; this copy only applies when that file cannot be
 * loaded (for example when the app is opened from the file system).
 * Keep the two in step.
 */
import type { AppConfig } from './types';

export const BUILTIN_CONFIG: AppConfig = {
  title: 'Road Surface Monitor',
  team: ['Member A', 'Member B', 'Member C', 'Member D'],
  course: 'IoT course, University of Twente',
  repoUrl: 'https://github.com/<org>/<repo>',
  theme: 'system',
  accent: '',
  motion: 1,
  units: { speed: 'kmh', coords: 'dd' },
  classes: [
    {
      id: 'smooth',
      name: 'Smooth',
      pattern: 'solid',
      hint: 'Even asphalt, low vibration',
      vibLevel: 0.9,
    },
    {
      id: 'rough',
      name: 'Rough',
      pattern: 'hatched',
      hint: 'Cobbles, cracks or gravel',
      vibLevel: 3.2,
    },
    {
      id: 'bump',
      name: 'Bump',
      pattern: 'pin',
      hint: 'Single impact: kerb, pothole or speed bump',
      vibLevel: 8.5,
    },
    { id: 'stopped', name: 'Stopped', pattern: 'hollow', hint: 'Not moving', vibLevel: 0.1 },
  ],
  aliases: {
    good: 'smooth',
    asphalt: 'smooth',
    flat: 'smooth',
    normal: 'smooth',
    bad: 'rough',
    cobble: 'rough',
    cobbles: 'rough',
    cobblestone: 'rough',
    gravel: 'rough',
    uneven: 'rough',
    pothole: 'bump',
    jolt: 'bump',
    impact: 'bump',
    shock: 'bump',
    idle: 'stopped',
    stationary: 'stopped',
    stop: 'stopped',
    still: 'stopped',
  },
  lowConfidence: 0.6,
  joinWindowMs: 3000,
  segmentLengthM: 25,
  comfort: { smoothWeight: 1, roughWeight: 0.5, bumpPenaltyPerKm: 3 },
  broker: {
    wsUrl: '',
    username: '',
    topicPrefix: 'road',
    extraTopics: ['owntracks/#'],
    owntracksMap: {},
    owntracksDefaultBike: 'bike1',
    noDataTimeoutS: 20,
  },
  map: {
    styleLight: 'https://basemaps.cartocdn.com/gl/positron-gl-style/style.json',
    styleDark: 'https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json',
    center: [6.876, 52.2305],
    zoom: 13.4,
    followZoomSlow: 17.2,
    followZoomFast: 15.6,
    followPitch: 45,
    graticule: false,
  },
  geocoding: {
    enabled: true,
    url: 'https://nominatim.openstreetmap.org/reverse',
    minIntervalMs: 1100,
    contact: '',
  },
  simulator: {
    routeUrl: 'sim/route.geojson',
    speed: 1,
    prefillS: 200,
    secondBike: false,
    errorRate: 0.04,
  },
};

/**
 * Configuration types. The defaults live in `public/config.json` (editable
 * without a rebuild); the user's changes from the settings drawer are
 * stored in localStorage and merged on top.
 */

export type ThemeSetting = 'system' | 'light' | 'dark';
export type SpeedUnit = 'kmh' | 'ms';
export type CoordFormat = 'dd' | 'dms';
export type PatternId = 'solid' | 'hatched' | 'pin' | 'hollow' | 'dotted';

/** One road-condition class as output by the trained model. */
export interface ConditionClass {
  /** Canonical id, lower case (for example "rough"). */
  id: string;
  /** Display name. */
  name: string;
  /** Line style used on the map and timeline, so colour is never the only cue. */
  pattern: PatternId;
  /** Short explanation shown next to the current condition. */
  hint: string;
  /** Vibration level (m/s^2) assumed when a message carries no `vib`. */
  vibLevel: number;
  /** Optional colour overrides (CSS colour strings). Defaults come from tokens.css. */
  colourLight?: string;
  colourDark?: string;
}

export interface BrokerConfig {
  /** WebSocket URL of the broker, for example wss://xxx.s1.eu.hivemq.cloud:8884/mqtt */
  wsUrl: string;
  username: string;
  /** First topic segment, for example "road". */
  topicPrefix: string;
  /** Extra topic filters subscribed in addition to <prefix>/+/#. */
  extraTopics: string[];
  /** Maps "owntracks/<user>/<device>" (or "<user>/<device>") to a bike id. */
  owntracksMap: Record<string, string>;
  /** Bike that receives OwnTracks positions not listed in owntracksMap. */
  owntracksDefaultBike: string;
  /** Seconds without a live message before the "no data" state shows. */
  noDataTimeoutS: number;
}

export interface MapConfig {
  styleLight: string;
  styleDark: string;
  /** Centre [lon, lat] and zoom used before any data arrives. */
  center: [number, number];
  zoom: number;
  /** Zoom used when following a bike at 0 km/h and at the "fast" speed. */
  followZoomSlow: number;
  followZoomFast: number;
  followPitch: number;
  graticule: boolean;
}

export interface GeocodingConfig {
  enabled: boolean;
  /** Reverse geocoding endpoint (Nominatim compatible). */
  url: string;
  /** Minimum gap between requests in ms (Nominatim policy: at least 1000). */
  minIntervalMs: number;
  /** Sent as the email parameter so the operator can contact the team. */
  contact: string;
}

export interface ComfortConfig {
  smoothWeight: number;
  roughWeight: number;
  bumpPenaltyPerKm: number;
}

export interface SimulatorConfig {
  routeUrl: string;
  /** Playback speed multiplier (1, 4, 10). */
  speed: number;
  /** Seconds of ride generated instantly at start so the screen is never empty. */
  prefillS: number;
  secondBike: boolean;
  /** Fraction of windows where the simulated model is wrong. */
  errorRate: number;
}

export interface AppConfig {
  title: string;
  team: string[];
  course: string;
  repoUrl: string;
  theme: ThemeSetting;
  /** Optional accent override (CSS colour). Empty string = token default. */
  accent: string;
  /** 0 to 1. Scales decorative motion; 0 behaves like reduced motion. */
  motion: number;
  units: { speed: SpeedUnit; coords: CoordFormat };
  classes: ConditionClass[];
  /** Lower-case alias -> class id, for models whose label names differ. */
  aliases: Record<string, string>;
  /** Below this confidence a sample is drawn faint or dotted. */
  lowConfidence: number;
  /** Condition/GPS join window in ms. */
  joinWindowMs: number;
  /** Segment length for the area report, in metres. */
  segmentLengthM: number;
  comfort: ComfortConfig;
  broker: BrokerConfig;
  map: MapConfig;
  geocoding: GeocodingConfig;
  simulator: SimulatorConfig;
}

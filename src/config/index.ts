/**
 * Config loading and persistence.
 *
 * Resolution order (later wins):
 *   1. BUILTIN_CONFIG (compiled in, last resort)
 *   2. public/config.json (deployed defaults, editable without a rebuild)
 *   3. .env.local values (VITE_BROKER_WS_URL and friends, never committed)
 *   4. user settings saved from the settings drawer (localStorage)
 *
 * `settings` holds only the keys the user changed, so editing config.json
 * later still takes effect for everything the user did not touch.
 */
import { BUILTIN_CONFIG } from './defaults';
import type { AppConfig } from './types';
import { Emitter } from '../utils/events';

const STORAGE_KEY = 'rsm.settings.v1';

type DeepPartial<T> = { [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K] };
export type ConfigPatch = DeepPartial<AppConfig>;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Recursive merge: objects merge, arrays and scalars replace. */
export function deepMerge<T>(base: T, patch: unknown): T {
  if (!isPlainObject(base) || !isPlainObject(patch))
    return (patch === undefined ? base : patch) as T;
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue;
    const cur = out[k];
    out[k] = isPlainObject(cur) && isPlainObject(v) ? deepMerge(cur, v) : v;
  }
  return out as T;
}

function readStoredSettings(): ConfigPatch {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as ConfigPatch) : {};
  } catch {
    return {};
  }
}

function envOverrides(): ConfigPatch {
  const env = import.meta.env;
  const broker: Partial<AppConfig['broker']> = {};
  if (env.VITE_BROKER_WS_URL && !String(env.VITE_BROKER_WS_URL).includes('{{')) {
    broker.wsUrl = String(env.VITE_BROKER_WS_URL);
  }
  if (env.VITE_BROKER_USERNAME) broker.username = String(env.VITE_BROKER_USERNAME);
  if (env.VITE_TOPIC_PREFIX) broker.topicPrefix = String(env.VITE_TOPIC_PREFIX);
  return Object.keys(broker).length ? { broker } : {};
}

/** Holds the live configuration and notifies listeners on change. */
export class ConfigStore extends Emitter<{ change: AppConfig }> {
  private deployed: AppConfig = BUILTIN_CONFIG;
  private settings: ConfigPatch = {};
  current: AppConfig = BUILTIN_CONFIG;

  async load(): Promise<AppConfig> {
    try {
      const res = await fetch(`${import.meta.env.BASE_URL}config.json`, { cache: 'no-cache' });
      if (res.ok) this.deployed = deepMerge(BUILTIN_CONFIG, await res.json());
    } catch {
      console.warn('config.json not reachable, using built-in defaults');
    }
    this.deployed = deepMerge(this.deployed, envOverrides());
    this.settings = readStoredSettings();
    this.recompute();
    return this.current;
  }

  /** Apply a partial change from the UI and persist it. */
  update(patch: ConfigPatch): void {
    this.settings = deepMerge(this.settings, patch);
    this.persist();
    this.recompute();
  }

  /** Replace all user settings (import from JSON). */
  replaceSettings(settings: ConfigPatch): void {
    this.settings = settings;
    this.persist();
    this.recompute();
  }

  resetSettings(): void {
    this.settings = {};
    localStorage.removeItem(STORAGE_KEY);
    this.recompute();
  }

  exportSettings(): ConfigPatch {
    return this.settings;
  }

  /** The config as deployed (config.json + env), without user changes. */
  get defaults(): AppConfig {
    return this.deployed;
  }

  private persist(): void {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.settings));
    } catch {
      /* storage full or disabled: settings stay in memory for this session */
    }
  }

  private recompute(): void {
    this.current = deepMerge(this.deployed, this.settings);
    this.emit('change', this.current);
  }
}

export const config = new ConfigStore();

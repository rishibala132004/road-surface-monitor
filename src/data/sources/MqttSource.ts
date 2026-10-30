/**
 * Live data over MQTT (WebSockets, normally WSS on port 8884 for HiveMQ
 * Cloud). Handles connect, subscribe, automatic reconnect with backoff and
 * reports an offline status so the UI can show it.
 *
 * mqtt.js is loaded lazily so the simulation-only start-up does not pay
 * for it.
 */
import type { MqttClient, connect as mqttConnect } from 'mqtt';
import { BaseSource } from './DataSource';

export interface MqttOptions {
  url: string;
  username?: string;
  password?: string;
  /** Topic filters to subscribe to. */
  topics: string[];
  clientIdPrefix?: string;
}

export class MqttSource extends BaseSource {
  readonly kind = 'live' as const;
  private client: MqttClient | null = null;
  private stopped = false;
  received = 0;
  lastError = '';

  constructor(private opts: MqttOptions) {
    super();
  }

  get url(): string {
    return this.opts.url;
  }

  async start(): Promise<void> {
    this.stopped = false;
    this.setStatus('starting', 'Connecting');
    // The browser build of mqtt.js only has a default export; the Node build has named ones.
    type Connect = typeof mqttConnect;
    const mod = (await import('mqtt')) as unknown as {
      connect?: Connect;
      default?: { connect: Connect };
    };
    const connect = mod.connect ?? mod.default?.connect;
    if (!connect) throw new Error('mqtt.js did not load');
    if (this.stopped) return;
    const clientId = `${this.opts.clientIdPrefix ?? 'rsm-dashboard'}-${Math.random().toString(16).slice(2, 8)}`;
    const client = connect(this.opts.url, {
      clientId,
      username: this.opts.username || undefined,
      password: this.opts.password || undefined,
      clean: true,
      keepalive: 30,
      connectTimeout: 10_000,
      reconnectPeriod: 2000,
      protocolVersion: 4,
    });
    this.client = client;
    let attempt = 0;

    client.on('connect', () => {
      attempt = 0;
      client.options.reconnectPeriod = 2000;
      const filters = this.opts.topics.filter(Boolean);
      client.subscribe(filters, { qos: 0 }, (err) => {
        if (err) this.setStatus('error', `Subscribe failed: ${err.message}`);
        else this.setStatus('running', `Subscribed to ${filters.join(', ')}`);
      });
    });
    client.on('message', (topic, payload) => {
      this.received++;
      this.emitMessage(topic, payload.toString(), Date.now());
    });
    client.on('reconnect', () => {
      attempt++;
      // Exponential backoff, capped at 30 s.
      client.options.reconnectPeriod = Math.min(30_000, 2000 * 2 ** Math.min(attempt, 4));
      this.setStatus('offline', `Reconnecting (attempt ${attempt})`);
    });
    client.on('offline', () => this.setStatus('offline', 'Broker unreachable'));
    client.on('close', () => {
      if (!this.stopped && this.status !== 'offline')
        this.setStatus('offline', 'Connection closed');
    });
    client.on('error', (err) => {
      this.lastError = err.message;
      this.setStatus('error', describeError(err.message));
    });
  }

  stop(): void {
    this.stopped = true;
    if (this.client) {
      this.client.end(true);
      this.client = null;
    }
    this.setStatus('idle');
  }
}

/** Turns the most common mqtt.js errors into something a teammate can act on. */
function describeError(message: string): string {
  const m = message.toLowerCase();
  if (m.includes('not authorized') || m.includes('bad user name'))
    return 'Login refused: check username and password';
  if (m.includes('websocket'))
    return 'WebSocket failed: check the URL (wss://host:8884/mqtt) and TLS';
  return message;
}

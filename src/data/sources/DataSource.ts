/**
 * Common interface for everything that produces raw (topic, payload)
 * messages: the simulator, the MQTT connection and the log replayer.
 * All three emit exactly the same shape, so the parser and the store never
 * know where data came from.
 */
import type { SourceKind } from '../store';

export type RawMessageHandler = (topic: string, payload: string, receivedAt: number) => void;

export type SourceStatus =
  'idle' | 'starting' | 'running' | 'paused' | 'offline' | 'error' | 'ended';

export interface DataSource {
  readonly kind: SourceKind;
  readonly status: SourceStatus;
  start(): Promise<void> | void;
  stop(): void;
  onMessage(handler: RawMessageHandler): void;
  onStatus(handler: (status: SourceStatus, detail?: string) => void): void;
}

/** Shared plumbing for the three implementations. */
export abstract class BaseSource implements DataSource {
  abstract readonly kind: SourceKind;
  status: SourceStatus = 'idle';
  protected handlers: RawMessageHandler[] = [];
  protected statusHandlers: ((status: SourceStatus, detail?: string) => void)[] = [];

  onMessage(handler: RawMessageHandler): void {
    this.handlers.push(handler);
  }

  onStatus(handler: (status: SourceStatus, detail?: string) => void): void {
    this.statusHandlers.push(handler);
  }

  protected emitMessage(topic: string, payload: string, receivedAt = Date.now()): void {
    for (const h of this.handlers) h(topic, payload, receivedAt);
  }

  protected setStatus(status: SourceStatus, detail?: string): void {
    this.status = status;
    for (const h of this.statusHandlers) h(status, detail);
  }

  abstract start(): Promise<void> | void;
  abstract stop(): void;
}

import { EventEmitter } from 'node:events';
import type { TrackerEvent } from '@tracklet/shared';

/** In-process pub/sub for tracker events (after they are committed). */
export class EventBus {
  private emitter = new EventEmitter();

  constructor() {
    this.emitter.setMaxListeners(1000);
  }

  publish(event: TrackerEvent): void {
    this.emitter.emit('event', event);
  }

  subscribe(listener: (event: TrackerEvent) => void): () => void {
    this.emitter.on('event', listener);
    return () => this.emitter.off('event', listener);
  }
}

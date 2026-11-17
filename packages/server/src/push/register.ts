/**
 * Wires push notifications into the server (D47). Every instance sends what's due (the outbox's
 * claims keep them apart); the lease holder prunes what was sent a week ago.
 */
import { backgroundFactories, choreFactories } from '../server';
import { prunePush, PushWorker } from './outbox';

choreFactories.push((runtime) => [{ name: 'push-prune', everyMs: 60 * 60_000, run: () => prunePush(runtime) }]);

backgroundFactories.push((runtime) => {
  if (!runtime.config.push.enabled) return null;
  const worker = new PushWorker(runtime);
  return { start: () => worker.start(), stop: () => worker.stop() };
});

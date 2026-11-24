/**
 * Wires chat into the server (D42): the outbox's consumer that writes a channel's posts runs on the
 * lease holder; every instance posts what's due; the lease holder prunes what was posted.
 */
import { backgroundFactories, choreFactories, consumerFactories } from '../server';
import { chatConsumer, ChatWorker, pruneChat } from './outbox';
import { syncHrCalendars } from '../services/hr-calendar';

consumerFactories.push(chatConsumer);

choreFactories.push((runtime) => [{ name: 'chat-prune', everyMs: 3_600_000, run: () => pruneChat(runtime) }]);
choreFactories.push((runtime) => [{ name: 'hr-calendars', everyMs: 6 * 3_600_000, run: () => syncHrCalendars(runtime) }]);

backgroundFactories.push((runtime) => {
  const sender = new ChatWorker(runtime);
  return { start: () => sender.start(), stop: () => sender.stop() };
});

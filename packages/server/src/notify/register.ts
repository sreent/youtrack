/**
 * Wires notifications into the server. The notifier and the help desk's mail are outbox consumers,
 * run by the lease holder. So are the chores done once for every instance: queueing the day's
 * digests, pruning, and, once per database, giving issues from before watching existed their
 * watchers. Every instance sends mail (the outbox's claims keep them apart) and serves inboxes.
 */
import { helpdeskConsumer } from '../helpdesk/consumer';
import { MailWorker, pruneMail, scheduleDigests } from '../mail/outbox';
import { backgroundFactories, choreFactories, consumerFactories } from '../server';
import { pruneHelpThrottle } from '../services/help-throttle';
import { backfillWatchers } from '../services/watchers';
import { notifierConsumer } from './notifier';
import { endInboxStreams } from './state';

consumerFactories.push(notifierConsumer, helpdeskConsumer);

choreFactories.push((runtime) => [
  {
    name: 'watchers-backfill',
    everyMs: 24 * 3_600_000,
    run: async () => {
      const n = await backfillWatchers(runtime);
      if (n) console.log(`watchers: ${n} added to issues from before watching existed`);
    },
  },
  { name: 'mail-digests', everyMs: 10 * 60_000, run: async () => void (await scheduleDigests(runtime)) },
  { name: 'mail-prune', everyMs: 60 * 60_000, run: () => pruneMail(runtime) },
  { name: 'help-throttle', everyMs: 5 * 60_000, run: () => pruneHelpThrottle(runtime.db) },
]);

backgroundFactories.push((runtime) => {
  const mail = new MailWorker(runtime);
  return {
    start: () => mail.start(),
    stop: async () => {
      // Open inboxes first, so the server can close; their clients reconnect elsewhere.
      endInboxStreams(runtime);
      await mail.stop();
    },
  };
});

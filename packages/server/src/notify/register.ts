/**
 * Wires notifications into the server: the notifier and the help desk's mail run in the outbox
 * worker, and the mail sender runs beside it. On first start, issues from before watching existed
 * get their watchers.
 */
import { helpdeskConsumer } from '../helpdesk/consumer';
import { MailWorker } from '../mail/outbox';
import { backgroundFactories, consumerFactories } from '../server';
import { backfillWatchers } from '../services/watchers';
import { notifierConsumer } from './notifier';

consumerFactories.push(notifierConsumer, helpdeskConsumer);
backgroundFactories.push((runtime) => {
  const mail = new MailWorker(runtime);
  return {
    start() {
      mail.start();
      void backfillWatchers(runtime)
        .then((n) => n && console.log(`  Watchers   ${n} added to issues from before watching existed`))
        .catch((e) => console.error('watchers: the backfill failed', e));
    },
    stop: () => mail.stop(),
  };
});

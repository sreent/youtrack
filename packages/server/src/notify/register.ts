/**
 * Wires notifications into the server: the notifier and the help desk's mail run in the outbox
 * worker, and the mail sender runs beside it.
 */
import { helpdeskConsumer } from '../helpdesk/consumer';
import { MailWorker } from '../mail/outbox';
import { backgroundFactories, consumerFactories } from '../server';
import { notifierConsumer } from './notifier';

consumerFactories.push(notifierConsumer, helpdeskConsumer);
backgroundFactories.push((runtime) => new MailWorker(runtime));

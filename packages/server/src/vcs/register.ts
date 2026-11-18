/**
 * Wires check runs on pull requests into the server (D66): the outbox's consumer that makes due the
 * checks an issue's change reaches runs on the lease holder; every instance writes what's due.
 */
import { backgroundFactories, consumerFactories } from '../server';
import { checksConsumer, ChecksSender } from './checks';

consumerFactories.push(checksConsumer);

backgroundFactories.push((runtime) => {
  const sender = new ChecksSender(runtime);
  return { start: () => sender.start(), stop: () => sender.stop() };
});

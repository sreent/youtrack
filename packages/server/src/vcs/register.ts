/**
 * Wires check runs on pull requests into the server (D66): the outbox's consumer that makes due the
 * checks an issue's change reaches runs on the lease holder; every instance writes what's due; the
 * lease holder forgets the rows of pull requests closed a while ago.
 */
import { backgroundFactories, choreFactories, consumerFactories } from '../server';
import { checksConsumer, ChecksSender, pruneChecks } from './checks';

consumerFactories.push(checksConsumer);

choreFactories.push((runtime) => [{ name: 'vcs-checks-prune', everyMs: 3_600_000, run: () => pruneChecks(runtime) }]);

backgroundFactories.push((runtime) => {
  const sender = new ChecksSender(runtime);
  return { start: () => sender.start(), stop: () => sender.stop() };
});

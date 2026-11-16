/**
 * Wires the help desk's mail into the server (D30): reading the shared mailbox when there is one,
 * and forgetting the log of what came in after 30 days. Both are chores, so only the lease holder
 * does them; a poll runs in the background, and the server waits for it as it stops.
 */
import { backgroundFactories, choreFactories } from '../server';
import { pollsDone, startPoll } from './imap';
import { pruneInbound } from './inbound';
import { prunePortal } from '../services/portal';
import { slaTick } from '../services/sla';

choreFactories.push((runtime) => [
  { name: 'helpdesk-inbound-prune', everyMs: 24 * 3_600_000, run: () => pruneInbound(runtime.db) },
  // What time alone brings to SLA targets (D45): at risk, past due. A minute at most late.
  { name: 'helpdesk-sla', everyMs: 60_000, run: async () => void (await slaTick(runtime)) },
  { name: 'helpdesk-portal-prune', everyMs: 6 * 3_600_000, run: () => prunePortal(runtime.db) },
  ...(runtime.config.helpdeskImapUrl ? [{ name: 'helpdesk-imap', everyMs: runtime.config.helpdeskImapPollMs, run: async () => startPoll(runtime) }] : []),
]);

backgroundFactories.push((runtime) => ({
  start: () => {},
  stop: () => pollsDone(runtime),
}));

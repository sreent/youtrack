/**
 * Wires the help desk's mail into the server (D30): reading the shared mailbox when there is one,
 * and forgetting the log of what came in after 30 days. Both are chores, so only the lease holder
 * does them; a poll runs in the background, and the server waits for it as it stops.
 */
import { backgroundFactories, choreFactories } from '../server';
import { pollsDone, startPoll } from './imap';
import { pruneInbound } from './inbound';
import { prunePortal } from '../services/portal';
import { prunePortalPasskeys } from '../services/portal-passkeys';
import { slaTick } from '../services/sla';
import { pruneTeamReplyTokens } from '../services/team-replies';
import { deskPollsDone, startDeskPolls } from '../services/desk-mailbox';

choreFactories.push((runtime) => [
  { name: 'helpdesk-inbound-prune', everyMs: 24 * 3_600_000, run: () => pruneInbound(runtime.db) },
  // What time alone brings to SLA targets (D45): at risk, past due. A minute at most late.
  { name: 'helpdesk-sla', everyMs: 60_000, run: async () => void (await slaTick(runtime)) },
  { name: 'helpdesk-portal-prune', everyMs: 6 * 3_600_000, run: () => prunePortal(runtime.db) },
  // Requesters' passkey challenges nobody answered, and their mails' links past their time (D69).
  { name: 'portal-passkeys-prune', everyMs: 15 * 60_000, run: () => prunePortalPasskeys(runtime.db) },
  { name: 'team-reply-tokens-prune', everyMs: 24 * 3_600_000, run: () => pruneTeamReplyTokens(runtime.db) },
  // Each desk's own mailbox (D45), in the background, as the shared one is.
  { name: 'helpdesk-desk-imap', everyMs: runtime.config.helpdeskImapPollMs, run: async () => void startDeskPolls(runtime) },
  ...(runtime.config.helpdeskImapUrl ? [{ name: 'helpdesk-imap', everyMs: runtime.config.helpdeskImapPollMs, run: async () => startPoll(runtime) }] : []),
]);

backgroundFactories.push((runtime) => ({
  start: () => {},
  stop: async () => {
    await pollsDone(runtime);
    await deskPollsDone(runtime);
  },
}));

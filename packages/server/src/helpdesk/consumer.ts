/**
 * Email to requesters, from the outbox: the team's public replies, and each change of state; and the
 * same to everyone copied on the request (D57). Their own replies, and everything internal, never go
 * back to them: a4a emails people outside the team only the team's words. One mail per person per
 * event, at least once.
 */
import type { TrackerEvent } from '@a4a/shared';
import { eq } from 'drizzle-orm';
import type { AppServices } from '../context';
import { activities, helpdeskRequests } from '../db/schema';
import type { OutboxConsumer } from '../events/worker';
import { enqueueMail, kickMail } from '../mail/outbox';
import { mailConfigured } from '../notify/state';
import { requestMessageId } from '../services/helpdesk';
import { ccsToTell } from '../services/request-ccs';
import { stateField } from '../services/schema-cache';

export function helpdeskConsumer(app: AppServices): OutboxConsumer {
  return {
    name: 'helpdesk-mail',
    types: ['comment.created', 'issue.updated'],
    handle: (event) => mailRequester(app, event),
  };
}

export async function mailRequester(app: AppServices, event: TrackerEvent): Promise<void> {
  if (!mailConfigured(app)) return;
  const data = event.data as { visibility?: string; requester?: unknown; commentId?: string };
  let kind: 'request-reply' | 'request-state';
  let payload: Record<string, unknown>;
  if (event.type === 'comment.created') {
    if (data.visibility !== 'public' || data.requester || !data.commentId) return;
    kind = 'request-reply';
    payload = { commentId: data.commentId };
  } else {
    const s = await app.schema.get();
    const state = stateField(s);
    const change = state ? event.changes.find((c) => c.field === state.name) : undefined;
    if (!change) return;
    kind = 'request-state';
    payload = { from: change.from, to: change.to, resolved: event.issue?.resolved ?? false };
  }
  const [row] = await app.db.select({ issueId: activities.issueId }).from(activities).where(eq(activities.id, event.id));
  if (!row?.issueId) return;
  const [request] = await app.db.select().from(helpdeskRequests).where(eq(helpdeskRequests.issueId, row.issueId));
  if (!request) return;
  let queued = false;
  if (!request.emailMutedAt) {
    queued = await enqueueMail(app.db, app, {
      kind,
      dedupeKey: `request-event:${event.id}`,
      // `replyable`: its Message-ID is random, so an answer that cites it is the requester's (D30).
      payload: { issueId: row.issueId, eventId: event.id, replyable: true, ...payload },
      messageId: requestMessageId(kind),
    });
  }
  // Those copied on it when it happened are told the same (D57), each by an email of their own:
  // its reply address answers for them, its link takes them off. The requester's stopping isn't theirs.
  for (const cc of await ccsToTell(app.db, row.issueId, new Date(event.occurredAt))) {
    const one = await enqueueMail(app.db, app, {
      kind,
      dedupeKey: `request-event:${event.id}:cc:${cc.id}`,
      payload: { issueId: row.issueId, eventId: event.id, replyable: true, ccId: cc.id, ...payload },
      messageId: requestMessageId(kind),
    });
    queued ||= one;
  }
  if (queued) kickMail(app);
}

/** What a notification says, in plain words: the same in the inbox, over MCP and by email. */
import type { NotificationKind, TrackerEvent } from '@a4a/shared';
import { joinList, type Locale, type Translator } from '@a4a/shared/i18n';
import { intlTag } from '../i18n';

/** Who did it, as a person reads it: a requester by their name, an agent by its id, an agent for a person says so. */
export function actorName(tr: Translator, e: TrackerEvent): string {
  const person = e.actor.name ?? e.actor.login ?? tr.t('server.notify.someone');
  switch (e.actor.channel) {
    case 'helpdesk':
      return String((e.data as { requester?: { name?: string } }).requester?.name ?? tr.t('server.notify.theRequester'));
    case 'automation':
      return e.actor.login ?? tr.t('server.notify.anAgent');
    case 'mcp':
      // A name begins the line it's in (an email's head, a push's title), so an agent with no token's name is "An agent".
      return tr.t('server.notify.agentFor', { agent: e.actor.token ?? tr.t('server.notify.anAgent'), person });
    case 'assistant':
      return tr.t('server.notify.assistantFor', { person });
    case 'api':
      return e.actor.token ? tr.t('server.notify.agentFor', { agent: e.actor.token, person }) : person;
    case 'chat':
      return person;
    case 'system':
      return 'a4a';
    default:
      return person;
  }
}

function list(tr: Translator, words: string[]): string {
  return joinList(tr.locale, words);
}

/** What one event did, as a verb phrase: "commented", "changed State and Priority". */
export function eventVerb(tr: Translator, e: TrackerEvent): string {
  const data = e.data as Record<string, unknown>;
  const t = tr.t;
  switch (e.type) {
    case 'issue.created':
      return data.requester ? t('server.notify.verb.askedForHelp') : t('server.notify.verb.reported');
    case 'issue.updated': {
      const fields = [...new Set(e.changes.map((c) => c.field))];
      return fields.length ? t('server.notify.verb.changedFields', { fields: list(tr, fields) }) : t('server.notify.verb.changedIt');
    }
    case 'comment.created':
      return data.requester ? t('server.notify.verb.replied') : data.visibility === 'public' ? t('server.notify.verb.repliedToRequester') : t('server.notify.verb.commented');
    case 'comment.updated':
      return t('server.notify.verb.editedComment');
    case 'link.created':
      return t('server.notify.verb.linked', { phrase: String(data.phrase ?? 'relates to' /* not words: a link type's phrase is data */), target: (data.target as { id?: string } | undefined)?.id ?? '' }).trim();
    case 'link.deleted':
      return t('server.notify.verb.unlinked', { target: (data.target as { id?: string } | undefined)?.id ?? t('server.notify.anIssue') });
    case 'attachment.added':
      return t('server.notify.verb.attached', { name: (data.attachment as { name?: string } | undefined)?.name ?? t('server.notify.aFile') });
    case 'attachment.removed':
      return t('server.notify.verb.removedFile', { name: (data.attachment as { name?: string } | undefined)?.name ?? '' }).trim();
    case 'issue.deleted':
      return t('server.notify.verb.deleted');
    case 'issue.moved':
      return t('server.notify.verb.moved', { from: String(data.from ?? t('server.notify.anotherProject')), to: String(data.to ?? t('server.notify.anotherProject')) });
    case 'rule.notified':
      return t('server.notify.verb.ruleMessage', { rule: ruleName(tr, e) });
    case 'rule.called':
      return t('server.notify.verb.ruleWebhook', { rule: ruleName(tr, e) });
    case 'script.called':
      return t('server.notify.verb.scriptWebhook', { origin: (e.data as { name?: unknown } | undefined)?.name ?? '' });
    case 'timesheet.submitted':
      return t('server.notify.verb.timesheetSubmitted', { who: (e.data as { user?: { name?: string } } | undefined)?.user?.name ?? '' });
    case 'timesheet.approved':
      return t('server.notify.verb.timesheetApproved', { who: (e.data as { user?: { name?: string } } | undefined)?.user?.name ?? '' });
    // These reach only those whose saved search an issue came into (D31).
    case 'comment.deleted':
      return t('server.notify.verb.deletedComment');
    case 'work.logged':
      return t('server.notify.verb.loggedTime');
    case 'work.deleted':
      return t('server.notify.verb.removedTime');
    case 'work.updated':
      return t('server.notify.verb.correctedTime');
    case 'sprint.issue_added':
      return t('server.notify.verb.addedToSprint');
    case 'sprint.issue_removed':
      return t('server.notify.verb.tookOutOfSprint');
    default:
      return t('server.notify.verb.changedIt');
  }
}

/** The workflow rule an event came from, by its name. */
function ruleName(tr: Translator, e: TrackerEvent): string {
  const name = (e.data.automation as { name?: unknown } | undefined)?.name;
  return typeof name === 'string' ? name : tr.t('server.notify.aWorkflowRule');
}

/** The lines under an event: its changes, or what was said. */
export function eventDetail(tr: Translator, e: TrackerEvent): string[] {
  const data = e.data as Record<string, unknown>;
  if (e.type === 'rule.notified') return typeof data.message === 'string' && data.message.trim() ? [data.message] : [];
  if (e.type === 'issue.updated') return e.changes.map((c) => tr.t('server.notify.change', { field: c.field, from: c.from ?? tr.t('server.notify.none'), to: c.to ?? tr.t('server.notify.none') }));
  if (e.type === 'comment.created' || e.type === 'comment.updated') return String(data.text ?? '').trim() ? [String(data.text)] : [];
  if (e.type === 'issue.created' && typeof data.description === 'string' && data.description.trim()) return [data.description];
  return [];
}

/** "Anna Schmidt mentioned you", "Anna Schmidt and Ben Okafor made 4 changes". */
export function notificationTitle(tr: Translator, kind: NotificationKind, events: TrackerEvent[], reasons: Map<number, NotificationKind>): string {
  const t = tr.t;
  // A search's chore tells of what time alone brought in: no event behind it, so no one did anything.
  if (!events.length) return kind === 'subscribed' ? t('server.notify.title.cameIn') : t('server.notify.title.somethingChanged');
  const lead = events.find((e) => reasons.get(e.id) === kind) ?? events[events.length - 1]!;
  const who = actorName(tr, lead);
  switch (kind) {
    case 'assigned':
      return lead.type === 'issue.created' ? t('server.notify.title.reportedAndAssigned', { who }) : t('server.notify.title.assigned', { who });
    case 'mentioned':
      return t('server.notify.title.mentioned', { who });
    case 'request':
      return t('server.notify.title.request', { who });
    case 'rule':
      return t('server.notify.title.rule', { rule: ruleName(tr, lead) });
    default: {
      if (events.length === 1) return t('server.notify.title.one', { who, did: eventVerb(tr, lead) });
      const people = [...new Set(events.map((e) => actorName(tr, e)))];
      const them = people.length === 1 ? who : people.length > 3 ? t('server.notify.title.andOthers', { people: list(tr, people.slice(0, 3)) }) : list(tr, people);
      const comments = events.filter((e) => e.type === 'comment.created').length;
      const changes = events.length - comments;
      if (!changes) return people.length === 1 ? t('server.notify.title.commentedTimes', { them, n: comments }) : t('server.notify.title.commented', { them });
      return comments ? t('server.notify.title.commentedAndChanged', { them, n: changes }) : t('server.notify.title.changed', { them, n: changes });
    }
  }
}

/** Why an email came, for its footer. */
export function because(tr: Translator, kind: NotificationKind): string {
  return tr.t(`server.notify.because.${kind}`);
}

/**
 * A moment as its reader reads it: in their time zone (D31), named, since they may be travelling:
 * "Mon 16 Nov, 10:02 CET". Without a zone, the server's.
 */
export function emailTime(iso: string, timeZone?: string, locale: Locale = 'en'): string {
  return new Date(iso).toLocaleString(intlTag(locale), {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    timeZoneName: 'short',
    ...(timeZone ? { timeZone } : {}),
  });
}

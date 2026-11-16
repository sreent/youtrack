/** What a notification says, in plain words: the same in the inbox, over MCP and by email. */
import type { NotificationKind, TrackerEvent } from '@a4a/shared';

/** Who did it, as a person reads it: a requester by their name, an agent by its id, an agent for a person says so. */
export function actorName(e: TrackerEvent): string {
  const person = e.actor.name ?? e.actor.login ?? 'Someone';
  switch (e.actor.channel) {
    case 'helpdesk':
      return String((e.data as { requester?: { name?: string } }).requester?.name ?? 'The requester');
    case 'automation':
      return e.actor.login ?? 'An agent';
    case 'mcp':
      return `${e.actor.token ?? 'an agent'} for ${person}`;
    case 'assistant':
      return `assistant for ${person}`;
    case 'api':
      return e.actor.token ? `${e.actor.token} for ${person}` : person;
    case 'system':
      return 'a4a';
    default:
      return person;
  }
}

function list(words: string[]): string {
  if (words.length <= 1) return words[0] ?? '';
  return `${words.slice(0, -1).join(', ')} and ${words[words.length - 1]}`;
}

/** What one event did, as a verb phrase: "commented", "changed State and Priority". */
export function eventVerb(e: TrackerEvent): string {
  const data = e.data as Record<string, unknown>;
  switch (e.type) {
    case 'issue.created':
      return data.requester ? 'asked for help through the help desk' : 'reported it';
    case 'issue.updated': {
      const fields = [...new Set(e.changes.map((c) => c.field))];
      return fields.length ? `changed ${list(fields)}` : 'changed it';
    }
    case 'comment.created':
      return data.requester ? 'replied' : data.visibility === 'public' ? 'replied to the requester' : 'commented';
    case 'comment.updated':
      return 'edited a comment';
    case 'link.created':
      return `linked it: ${String(data.phrase ?? 'relates to')} ${(data.target as { id?: string } | undefined)?.id ?? ''}`.trim();
    case 'link.deleted':
      return `unlinked it from ${(data.target as { id?: string } | undefined)?.id ?? 'an issue'}`;
    case 'attachment.added':
      return `attached ${(data.attachment as { name?: string } | undefined)?.name ?? 'a file'}`;
    case 'attachment.removed':
      return `removed the file ${(data.attachment as { name?: string } | undefined)?.name ?? ''}`.trim();
    case 'issue.deleted':
      return 'deleted it';
    // These reach only those whose saved search an issue came into (D31).
    case 'comment.deleted':
      return 'deleted a comment';
    case 'work.logged':
      return 'logged time on it';
    case 'work.deleted':
      return 'removed time logged on it';
    case 'sprint.issue_added':
      return 'added it to a sprint';
    case 'sprint.issue_removed':
      return 'took it out of a sprint';
    default:
      return 'changed it';
  }
}

/** The lines under an event: its changes, or what was said. */
export function eventDetail(e: TrackerEvent): string[] {
  const data = e.data as Record<string, unknown>;
  if (e.type === 'issue.updated') return e.changes.map((c) => `${c.field}: ${c.from ?? 'none'} → ${c.to ?? 'none'}`);
  if (e.type === 'comment.created' || e.type === 'comment.updated') return String(data.text ?? '').trim() ? [String(data.text)] : [];
  if (e.type === 'issue.created' && typeof data.description === 'string' && data.description.trim()) return [data.description];
  return [];
}

/** "Anna Schmidt mentioned you", "Anna Schmidt and Ben Okafor made 4 changes". */
export function notificationTitle(kind: NotificationKind, events: TrackerEvent[], reasons: Map<number, NotificationKind>): string {
  if (!events.length) return 'Something changed';
  const lead = events.find((e) => reasons.get(e.id) === kind) ?? events[events.length - 1]!;
  const who = actorName(lead);
  switch (kind) {
    case 'assigned':
      return lead.type === 'issue.created' ? `${who} reported it and assigned it to you` : `${who} assigned it to you`;
    case 'mentioned':
      return `${who} mentioned you`;
    case 'request':
      return `${who} asked for help through the help desk`;
    default: {
      if (events.length === 1) return `${who} ${eventVerb(lead)}`;
      const people = [...new Set(events.map(actorName))];
      const them = people.length === 1 ? who : `${list(people.slice(0, 3))}${people.length > 3 ? ' and others' : ''}`;
      const comments = events.filter((e) => e.type === 'comment.created').length;
      const changes = events.length - comments;
      const times = comments === 2 ? ' twice' : comments > 2 ? ` ${comments} times` : '';
      if (!changes) return `${them} commented${people.length === 1 ? times : ''}`;
      const made = `made ${changes} ${changes === 1 ? 'change' : 'changes'}`;
      return comments ? `${them} commented and ${made}` : `${them} ${made}`;
    }
  }
}

/** Why an email came, for its footer. */
export const BECAUSE: Record<NotificationKind, string> = {
  assigned: 'it was assigned to you',
  mentioned: 'you were mentioned',
  request: 'you lead the project its help desk is for',
  watching: 'you watch the issue',
  subscribed: 'you subscribed to it',
};

/**
 * A moment as its reader reads it: in their time zone (D31), named, since they may be travelling:
 * "Mon 16 Nov, 10:02 CET". Without a zone, the server's.
 */
export function emailTime(iso: string, timeZone?: string): string {
  return new Date(iso).toLocaleString('en-GB', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    timeZoneName: 'short',
    ...(timeZone ? { timeZone } : {}),
  });
}

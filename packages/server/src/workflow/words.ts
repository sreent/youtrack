/** A rule's schedule and the rule itself, in words and in time. */
import type { RuleKind, RuleSchedule, RuleTrigger } from '@a4a/shared';
import { excerpt } from '../lib/text';

export const DEFAULT_AT = '09:00';

/** The next time a schedule comes round after `after`, in the server's time zone. */
export function nextRunAfter(schedule: RuleSchedule, after: Date): Date {
  const d = new Date(after.getTime());
  if (schedule.every === 'hour') {
    d.setMinutes(0, 0, 0);
    d.setHours(d.getHours() + 1);
    return d;
  }
  const [h, m] = (schedule.at ?? DEFAULT_AT).split(':').map(Number) as [number, number];
  d.setHours(h, m, 0, 0);
  if (d.getTime() <= after.getTime()) d.setDate(d.getDate() + 1);
  if (schedule.every === 'weekday') while (d.getDay() === 0 || d.getDay() === 6) d.setDate(d.getDate() + 1);
  return d;
}

export function scheduleWords(schedule: RuleSchedule | null | undefined): string {
  if (!schedule) return 'On a schedule';
  if (schedule.every === 'hour') return 'Every hour';
  const at = schedule.at ?? DEFAULT_AT;
  return schedule.every === 'weekday' ? `Every weekday at ${at}` : `Every day at ${at}`;
}

export function triggerWords(trigger: RuleTrigger | null | undefined, field: string | null | undefined): string {
  if (trigger === 'created') return 'an issue is created';
  if (trigger === 'commented') return 'an issue gets a comment';
  return field ? `an issue's ${field} changes` : 'an issue changes';
}

interface Readable {
  kind: RuleKind;
  trigger: RuleTrigger | null;
  field: string | null;
  schedule: RuleSchedule | null;
  query: string;
  command: string;
  comment: string | null;
  requires: string | null;
  message: string | null;
}

function then(r: Readable): string {
  const command = r.command.trim();
  const comment = r.comment?.trim() ? `comment “${excerpt(r.comment.trim(), 80)}”` : '';
  if (command && comment) return `apply “${command}” and ${comment}`;
  return command ? `apply “${command}”` : comment || 'do nothing';
}

/** The rule as a sentence: When … if … then … */
export function ruleSentence(r: Readable): string {
  const query = r.query.trim();
  switch (r.kind) {
    case 'change':
      return `When ${triggerWords(r.trigger, r.field)}${query ? `, if it matches “${query}”` : ''}, then ${then(r)}.`;
    case 'schedule':
      return `${scheduleWords(r.schedule)}, ${query ? `if an issue matches “${query}”` : 'for every issue'}, then ${then(r)}.`;
    case 'guard':
      return `When a change would make an issue match “${query}”, if it doesn't also match “${r.requires?.trim() ?? ''}”, then refuse the change${
        r.message?.trim() ? `: “${r.message.trim()}”` : ''
      }`;
  }
}

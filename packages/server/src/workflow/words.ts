/** A rule's schedule and the rule itself, in words and in time. */
import type { RuleKind, RuleNotify, RuleRelated, RuleSchedule, RuleTarget, RuleTell, RuleTrigger } from '@a4a/shared';
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
  related?: RuleRelated | null;
  target?: RuleTarget | null;
  notify?: RuleNotify | null;
  /** Where the webhook it calls is (https://host), or null when it calls none. */
  callOrigin?: string | null;
  /** Whether it calls a webhook at all, even one whose address isn't known here. */
  calls?: boolean;
}

export function listWords(words: string[]): string {
  if (words.length <= 1) return words[0] ?? '';
  return `${words.slice(0, -1).join(', ')} and ${words[words.length - 1]}`;
}

/** "all of its subtasks match “#Resolved”", "its parent matches “State: Open”". */
export function relatedWords(r: Pick<RuleRelated, 'of' | 'phrase' | 'match' | 'query'>): string {
  const q = `“${r.query.trim()}”`;
  const all = r.match !== 'any';
  switch (r.of) {
    case 'parent':
      return `its parent matches ${q}`;
    case 'subtasks':
      return all ? `all of its subtasks match ${q}` : `any of its subtasks matches ${q}`;
    case 'siblings':
      return all ? `all of its parent's subtasks match ${q}` : `any of its parent's subtasks matches ${q}`;
    case 'linked': {
      const phrase = r.phrase?.trim() || 'is linked to';
      return all ? `all the issues it ${phrase} match ${q}` : `any issue it ${phrase} matches ${q}`;
    }
  }
}

/** " to its parent", " to its subtasks", " to the issues it depends on"; nothing for the issue itself. */
export function targetWords(t: RuleTarget | null | undefined): string {
  switch (t?.to ?? 'issue') {
    case 'parent':
      return ' to its parent';
    case 'subtasks':
      return ' to its subtasks';
    case 'linked':
      return ` to the issues it ${t?.phrase?.trim() || 'is linked to'}`;
    default:
      return '';
  }
}

const TELL_WORDS: Record<Exclude<RuleTell, 'managers'>, string> = { assignee: 'assignee', reporter: 'reporter', watchers: 'watchers' };

/** Someone of each issue a rule acts on: "its assignee", "its parent's watchers", "the reporter of each issue it depends on". */
function ofTarget(t: RuleTarget | null | undefined, who: Exclude<RuleTell, 'managers'>): string {
  const word = TELL_WORDS[who];
  switch (t?.to ?? 'issue') {
    case 'parent':
      return `its parent's ${word}`;
    case 'subtasks':
      return `each subtask's ${word}`;
    case 'linked':
      return `the ${word} of each issue it ${t?.phrase?.trim() || 'is linked to'}`;
    default:
      return `its ${word}`;
  }
}

/** "tell its assignee and @anna “It's yours now.”" */
export function notifyWords(n: Pick<RuleNotify, 'to' | 'people' | 'message'>, t: RuleTarget | null | undefined): string {
  const mine = n.to.map((k) => (k === 'managers' ? "the project's managers" : ofTarget(t, k)));
  const named = n.people.map((p) => `@${p}`);
  return `tell ${listWords([...mine, ...named]) || 'nobody'} “${excerpt(n.message.trim(), 120)}”`;
}

function then(r: Readable): string {
  const command = r.command.trim();
  const comment = r.comment?.trim() ? `comment “${excerpt(r.comment.trim(), 80)}”` : '';
  const actions: string[] = [];
  const onWhat = targetWords(r.target);
  if (command && comment) actions.push(`apply “${command}” and ${comment}${onWhat}`);
  else if (command) actions.push(`apply “${command}”${onWhat}`);
  else if (comment) actions.push(`${comment}${onWhat ? onWhat.replace(/^ to /, ' on ') : ''}`);
  if (r.notify) actions.push(notifyWords(r.notify, r.target));
  if (r.calls || r.callOrigin) {
    const about = !command && !comment && onWhat ? onWhat.replace(/^ to /, ' about ') : '';
    actions.push(`call ${r.callOrigin ?? 'a webhook'}${about}`);
  }
  return listWords(actions) || 'do nothing';
}

/** A sentence's full stop, unless it ends with a quote that has one already. */
export function fullStop(sentence: string): string {
  return /[.!?…]”$/.test(sentence) ? sentence : `${sentence}.`;
}

/** The rule as a sentence: When … if … then … */
export function ruleSentence(r: Readable): string {
  const query = r.query.trim();
  const rel = r.related?.query.trim() ? relatedWords(r.related) : '';
  switch (r.kind) {
    case 'change': {
      const cond = query ? `, if it matches “${query}”${rel ? ` and ${rel}` : ''}` : rel ? `, if ${rel}` : '';
      return fullStop(`When ${triggerWords(r.trigger, r.field)}${cond}, then ${then(r)}`);
    }
    case 'schedule': {
      const cond = query ? `if an issue matches “${query}”${rel ? ` and ${rel}` : ''}` : rel ? `for every issue where ${rel}` : 'for every issue';
      return fullStop(`${scheduleWords(r.schedule)}, ${cond}, then ${then(r)}`);
    }
    case 'guard':
      return `When a change would make an issue match “${query}”, if it doesn't also match “${r.requires?.trim() ?? ''}”, then refuse the change${
        r.message?.trim() ? `: “${r.message.trim()}”` : ''
      }`;
  }
}

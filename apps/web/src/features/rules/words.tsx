import type { Rule, RuleNotify, RuleRelated, RuleSchedule, RuleTarget, RuleTrigger } from '@a4a/shared';
import type React from 'react';

/** As the server says them (workflow/words.ts): a rule's parts in words. */
export function triggerWords(trigger: RuleTrigger | null, field: string | null): string {
  if (trigger === 'created') return 'an issue is created';
  if (trigger === 'commented') return 'an issue gets a comment';
  return field ? `an issue's ${field} changes` : 'an issue changes';
}

export function scheduleWords(schedule: RuleSchedule | null): string {
  if (!schedule) return 'On a schedule';
  if (schedule.every === 'hour') return 'Every hour';
  return `Every ${schedule.every === 'weekday' ? 'weekday' : 'day'} at ${schedule.at ?? '09:00'}`;
}

/** " to its parent", " to its subtasks", " to the issues it depends on"; nothing for the issue itself. */
export function targetWords(t: Pick<RuleTarget, 'to' | 'phrase'> | null | undefined): string {
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

const TELL = { assignee: 'assignee', reporter: 'reporter', watchers: 'watchers' } as const;

/** Someone of each issue a rule acts on: "its assignee", "its parent's watchers", "the reporter of each issue it depends on". */
function ofTarget(t: Pick<RuleTarget, 'to' | 'phrase'> | null | undefined, who: keyof typeof TELL): string {
  const word = TELL[who];
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

export function listWords(words: string[]): string {
  if (words.length <= 1) return words[0] ?? '';
  return `${words.slice(0, -1).join(', ')} and ${words[words.length - 1]}`;
}

/** Whom a rule tells: "its assignee and @anna". */
export function recipientWords(n: Pick<RuleNotify, 'to' | 'people'>, t: Pick<RuleTarget, 'to' | 'phrase'> | null | undefined): string {
  const mine = n.to.map((k) => (k === 'managers' ? "the project's managers" : ofTarget(t, k)));
  return listWords([...mine, ...n.people.map((p) => `@${p}`)]) || 'nobody';
}

/** "all of its subtasks match", before the query. */
export function relatedLead(r: Pick<RuleRelated, 'of' | 'phrase' | 'match'>): string {
  const all = r.match !== 'any';
  switch (r.of) {
    case 'parent':
      return 'its parent matches';
    case 'subtasks':
      return all ? 'all of its subtasks match' : 'any of its subtasks matches';
    case 'siblings':
      return all ? "all of its parent's subtasks match" : "any of its parent's subtasks matches";
    case 'linked':
      return all ? `all the issues it ${r.phrase?.trim() || 'is linked to'} match` : `any issue it ${r.phrase?.trim() || 'is linked to'} matches`;
  }
}

type Parts = Pick<Rule, 'kind' | 'trigger' | 'field' | 'schedule' | 'query' | 'command' | 'comment' | 'requires' | 'message'> &
  Partial<Pick<Rule, 'related' | 'target' | 'notify' | 'call'>>;

const short = (text: string, n: number) => (text.length > n ? `${text.slice(0, n - 1)}…` : text);

/** The things a rule does after its "then", each its own phrase. */
function actions(rule: Parts): React.ReactNode[] {
  const out: React.ReactNode[] = [];
  const comment = rule.comment?.trim();
  const onWhat = targetWords(rule.target);
  if (rule.command || comment) {
    out.push(
      <>
        {rule.command ? (
          <>
            apply <code>{rule.command}</code>
          </>
        ) : null}
        {rule.command && comment ? ' and ' : null}
        {comment ? <>comment “{short(comment, 80)}”</> : null}
        {rule.command ? onWhat : onWhat.replace(/^ to /, ' on ')}
      </>,
    );
  }
  if (rule.notify) out.push(<>tell {recipientWords(rule.notify, rule.target)} “{short(rule.notify.message, 120)}”</>);
  if (rule.call) {
    out.push(
      <>
        call <span className="mono">{rule.call.origin ?? 'a webhook'}</span>
        {!rule.command && !comment ? onWhat.replace(/^ to /, ' about ') : ''}
      </>,
    );
  }
  return out;
}

function Then({ rule }: { rule: Parts }) {
  const parts = actions(rule);
  return (
    <>
      <span className="rule-word">then</span>{' '}
      {parts.length
        ? parts.map((p, i) => (
            <span key={i}>
              {i === 0 ? null : i === parts.length - 1 ? ' and ' : ', '}
              {p}
            </span>
          ))
        : 'do nothing'}
    </>
  );
}

/** No full stop after a quoted message that ends one already, as the server says it. */
function stop(rule: Parts): string {
  if (rule.call || !rule.notify) return '.';
  return /[.!?…]$/.test(short(rule.notify.message.trim(), 120)) ? '' : '.';
}

function Related({ rule }: { rule: Parts }) {
  const r = rule.related;
  if (!r?.query.trim()) return null;
  return (
    <>
      {relatedLead(r)} <code>{r.query}</code>
    </>
  );
}

/** Ocean's Rule sentence: When … if … then …, its three words in --text, the query and command as written. */
export function Sentence({ rule }: { rule: Parts }) {
  const query = rule.query.trim();
  const related = rule.related?.query.trim() ? <Related rule={rule} /> : null;
  if (rule.kind === 'guard') {
    return (
      <p className="rule-sentence">
        <span className="rule-word">When</span> a change would make an issue match <code>{query}</code>, <span className="rule-word">if</span> it doesn't also
        match <code>{rule.requires}</code>, <span className="rule-word">then</span> refuse the change{rule.message ? <>: “{rule.message}”</> : '.'}
      </p>
    );
  }
  if (rule.kind === 'schedule') {
    return (
      <p className="rule-sentence">
        <span className="rule-word">{scheduleWords(rule.schedule)}</span>,{' '}
        {query ? (
          <>
            <span className="rule-word">if</span> an issue matches <code>{query}</code>
            {related ? <> and {related}</> : null}
          </>
        ) : related ? (
          <>for every issue where {related}</>
        ) : (
          'for every issue'
        )}
        , <Then rule={rule} />
        {stop(rule)}
      </p>
    );
  }
  return (
    <p className="rule-sentence">
      <span className="rule-word">When</span> {triggerWords(rule.trigger, rule.field)}
      {query ? (
        <>
          , <span className="rule-word">if</span> it matches <code>{query}</code>
          {related ? <> and {related}</> : null}
        </>
      ) : related ? (
        <>
          , <span className="rule-word">if</span> {related}
        </>
      ) : null}
      , <Then rule={rule} />
      {stop(rule)}
    </p>
  );
}

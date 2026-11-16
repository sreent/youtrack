import type { Rule, RuleNotify, RuleRelated, RuleSchedule, RuleTarget, RuleTrigger } from '@a4a/shared';
import type React from 'react';
import { t, tr } from '../../i18n';
import type { ReactNode } from 'react';

/** As the server says them (workflow/words.ts): a rule's parts in words. */
export function triggerWords(trigger: RuleTrigger | null, field: string | null): string {
  if (trigger === 'created') return 'an issue is created';
  if (trigger === 'commented') return 'an issue gets a comment';
  return field ? `an issue's ${field} changes` : 'an issue changes';
}

export function scheduleWords(schedule: RuleSchedule | null): string {
  if (!schedule) return t('rules.words.onASchedule');
  if (schedule.every === 'hour') return t('rules.words.everyHour');
  return t('rules.words.everyAt', { v: schedule.every === 'weekday' ? 'weekday' : 'day', v2: schedule.at ?? '09:00' });
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
  Partial<Pick<Rule, 'related' | 'target' | 'notify' | 'call' | 'script'>>;

const short = (text: string, n: number) => (text.length > n ? `${text.slice(0, n - 1)}…` : text);

/** The things a rule does after its "then", each its own phrase. */
function actions(rule: Parts): React.ReactNode[] {
  const out: React.ReactNode[] = [];
  // A scripted rule (D40) runs its script where a command would be.
  if (rule.script?.trim()) out.push('run its script');
  const comment = rule.comment?.trim();
  const onWhat = targetWords(rule.target);
  if (!rule.script?.trim() && (rule.command || comment)) {
    out.push(
      <>
        {rule.command ? (
          <>{tr('rules.words.apply', { code: <code>{rule.command}</code> })}</>
        ) : null}
        {rule.command && comment ? ' and ' : null}
        {comment ? <>{tr('rules.words.comment', { short: short(comment, 80) })}</> : null}
        {rule.command ? onWhat : onWhat.replace(/^ to /, ' on ')}
      </>,
    );
  }
  if (rule.notify) out.push(<>{tr('rules.words.tell', { recipientWords: recipientWords(rule.notify, rule.target), short: short(rule.notify.message, 120) })}</>);
  if (rule.call) {
    out.push(
      <>{tr('rules.words.call', { v: rule.call.origin ?? 'a webhook', t0: (c: ReactNode) => <span className="mono">{c}</span>, v2: !rule.command && !comment ? onWhat.replace(/^ to /, ' about ') : '' })}</>,
    );
  }
  return out;
}

function Then({ rule }: { rule: Parts }) {
  const parts = actions(rule);
  return (
    <>
      <span className="rule-word">{t('rules.words.then')}</span>{' '}
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
  if (rule.kind === 'guard' && rule.script?.trim()) {
    return (
      <p className="rule-sentence">{tr('rules.words.whenAChangeIsMade', { t0: (c: ReactNode) => <span className="rule-word">{c}</span>, v: query ? <>{tr('rules.words.anIssueThatMatches', { code: <code>{query}</code> })}</> : 'an issue', t1: (c: ReactNode) => <span className="rule-word">{c}</span> })}</p>
    );
  }
  if (rule.kind === 'guard') {
    return (
      <p className="rule-sentence">{tr('rules.words.whenAChangeWouldMake', { t0: (c: ReactNode) => <span className="rule-word">{c}</span>, code: <code>{query}</code>, t1: (c: ReactNode) => <span className="rule-word">{c}</span>, code2: <code>{rule.requires}</code>, t2: (c: ReactNode) => <span className="rule-word">{c}</span>, v: rule.message ? <>: “{rule.message}”</> : '.' })}</p>
    );
  }
  if (rule.kind === 'schedule') {
    return (
      <p className="rule-sentence">
        <span className="rule-word">{scheduleWords(rule.schedule)}</span>,{' '}
        {query ? (
          <>{tr('rules.words.ifAnIssueMatches', { t0: (c: ReactNode) => <span className="rule-word">{c}</span>, code: <code>{query}</code>, v: related ? <>{tr('rules.words.and', { related: related })}</> : null })}</>
        ) : related ? (
          <>{tr('rules.words.forEveryIssueWhere', { related: related })}</>
        ) : (
          t('rules.words.forEveryIssue')
        )}
        , <Then rule={rule} />
        {stop(rule)}
      </p>
    );
  }
  return (
    <p className="rule-sentence">
      <span className="rule-word">{t('rules.words.when')}</span> {triggerWords(rule.trigger, rule.field)}
      {query ? (
        <>{tr('rules.words.ifItMatches', { t0: (c: ReactNode) => <span className="rule-word">{c}</span>, code: <code>{query}</code>, v: related ? <>{tr('rules.words.and', { related: related })}</> : null })}</>
      ) : related ? (
        <>
          , <span className="rule-word">{t('rules.words.if')}</span> {related}
        </>
      ) : null}
      , <Then rule={rule} />
      {stop(rule)}
    </p>
  );
}

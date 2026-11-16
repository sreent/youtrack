import type { Rule, RuleNotify, RuleRelated, RuleSchedule, RuleTarget, RuleTrigger } from '@a4a/shared';
import type React from 'react';
import { t as tx, tr } from '../../i18n';
import type { ReactNode } from 'react';

/** As the server says them (workflow/words.ts): a rule's parts in words. */
export function triggerWords(trigger: RuleTrigger | null, field: string | null): string {
  if (trigger === 'created') return tx('rules.words.anIssueIsCreated');
  if (trigger === 'commented') return tx('rules.words.anIssueGetsAComment');
  return field ? tx('rules.words.anIssueSChanges', { field: field }) : tx('rules.words.anIssueChanges');
}

export function scheduleWords(schedule: RuleSchedule | null): string {
  if (!schedule) return tx('rules.words.onASchedule');
  if (schedule.every === 'hour') return tx('rules.words.everyHour');
  return tx('rules.words.everyAt', { v: schedule.every === 'weekday' ? 'weekday' : 'day', v2: schedule.at ?? '09:00' });
}

/** " to its parent", " to its subtasks", " to the issues it depends on"; nothing for the issue itself. */
export function targetWords(t: Pick<RuleTarget, 'to' | 'phrase'> | null | undefined): string {
  switch (t?.to ?? 'issue') {
    case 'parent':
      return tx('rules.words.toItsParent');
    case 'subtasks':
      return tx('rules.words.toItsSubtasks');
    case 'linked':
      return tx('rules.words.toTheIssuesIt', { v: t?.phrase?.trim() || tx('rules.words.isLinkedTo') });
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
      return tx('rules.words.itsParentS', { word: word });
    case 'subtasks':
      return tx('rules.words.eachSubtaskS', { word: word });
    case 'linked':
      return tx('rules.words.theOfEachIssueIt', { word: word, v: t?.phrase?.trim() || tx('rules.words.isLinkedTo') });
    default:
      return tx('rules.words.its', { word: word });
  }
}

export function listWords(words: string[]): string {
  if (words.length <= 1) return words[0] ?? '';
  return tx('rules.words.and2', { join: words.slice(0, -1).join(', '), v: words[words.length - 1] });
}

/** Whom a rule tells: "its assignee and @anna". */
export function recipientWords(n: Pick<RuleNotify, 'to' | 'people'>, t: Pick<RuleTarget, 'to' | 'phrase'> | null | undefined): string {
  const mine = n.to.map((k) => (k === 'managers' ? tx('rules.words.theProjectSManagers') : ofTarget(t, k)));
  return listWords([...mine, ...n.people.map((p) => `@${p}`)]) || tx('rules.words.nobody');
}

/** "all of its subtasks match", before the query. */
export function relatedLead(r: Pick<RuleRelated, 'of' | 'phrase' | 'match'>): string {
  const all = r.match !== 'any';
  switch (r.of) {
    case 'parent':
      return tx('rules.words.itsParentMatches');
    case 'subtasks':
      return all ? tx('rules.words.allOfItsSubtasksMatch') : tx('rules.words.anyOfItsSubtasksMatches');
    case 'siblings':
      return all ? tx('rules.words.allOfItsParentS') : tx('rules.words.anyOfItsParentS');
    case 'linked':
      return all ? tx('rules.words.allTheIssuesItMatch', { v: r.phrase?.trim() || tx('rules.words.isLinkedTo') }) : tx('rules.words.anyIssueItMatches', { v: r.phrase?.trim() || tx('rules.words.isLinkedTo') });
  }
}

type Parts = Pick<Rule, 'kind' | 'trigger' | 'field' | 'schedule' | 'query' | 'command' | 'comment' | 'requires' | 'message'> &
  Partial<Pick<Rule, 'related' | 'target' | 'notify' | 'call' | 'script'>>;

const short = (text: string, n: number) => (text.length > n ? `${text.slice(0, n - 1)}…` : text);

/** The things a rule does after its "then", each its own phrase. */
function actions(rule: Parts): React.ReactNode[] {
  const out: React.ReactNode[] = [];
  // A scripted rule (D40) runs its script where a command would be.
  if (rule.script?.trim()) out.push(tx('rules.words.runItsScript'));
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
      <>{tr('rules.words.call', { v: rule.call.origin ?? tx('rules.words.aWebhook'), t0: (c: ReactNode) => <span className="mono">{c}</span>, v2: !rule.command && !comment ? onWhat.replace(/^ to /, ' about ') : '' })}</>,
    );
  }
  return out;
}

function Then({ rule }: { rule: Parts }) {
  const parts = actions(rule);
  return (
    <>
      <span className="rule-word">{tx('rules.words.then')}</span>{' '}
      {parts.length
        ? parts.map((p, i) => (
            <span key={i}>
              {i === 0 ? null : i === parts.length - 1 ? ' and ' : ', '}
              {p}
            </span>
          ))
        : tx('rules.words.doNothing')}
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
      <p className="rule-sentence">{tr('rules.words.whenAChangeIsMade', { t0: (c: ReactNode) => <span className="rule-word">{c}</span>, v: query ? <>{tr('rules.words.anIssueThatMatches', { code: <code>{query}</code> })}</> : tx('rules.words.anIssue'), t1: (c: ReactNode) => <span className="rule-word">{c}</span> })}</p>
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
          tx('rules.words.forEveryIssue')
        )}
        , <Then rule={rule} />
        {stop(rule)}
      </p>
    );
  }
  return (
    <p className="rule-sentence">
      <span className="rule-word">{tx('rules.words.when')}</span> {triggerWords(rule.trigger, rule.field)}
      {query ? (
        <>{tr('rules.words.ifItMatches', { t0: (c: ReactNode) => <span className="rule-word">{c}</span>, code: <code>{query}</code>, v: related ? <>{tr('rules.words.and', { related: related })}</> : null })}</>
      ) : related ? (
        <>
          , <span className="rule-word">{tx('rules.words.if')}</span> {related}
        </>
      ) : null}
      , <Then rule={rule} />
      {stop(rule)}
    </p>
  );
}

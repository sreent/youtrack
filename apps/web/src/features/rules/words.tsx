import type { Rule, RuleNotify, RuleRelated, RuleSchedule, RuleTarget, RuleTrigger } from '@a4a/shared';
import type React from 'react';
import { formatList, listNodes, t as tx, tr } from '../../i18n';
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
  return tx('rules.words.everyDayAt', { every: schedule.every === 'weekday' ? 'weekday' : 'day', at: schedule.at ?? '09:00' });
}

/**
 * The issues an action reaches, as a code its message words (D49): its parent, its subtasks, the issues
 * it's linked to (by the link's phrase), or none for the issue itself.
 */
function targetOf(t: Pick<RuleTarget, 'to' | 'phrase'> | null | undefined): { target: string; phrase: string } {
  const to = t?.to ?? 'issue';
  return { target: to === 'parent' || to === 'subtasks' || to === 'linked' ? to : 'none', phrase: t?.phrase?.trim() || tx('rules.words.isLinkedTo') };
}

const TELL = { assignee: tx('rules.words.whoAssignee'), reporter: tx('rules.words.whoReporter'), watchers: tx('rules.words.whoWatchers') } as const;

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
  return formatList(words);
}

/** Whom a rule tells: "its assignee and @anna". */
export function recipientWords(n: Pick<RuleNotify, 'to' | 'people'>, t: Pick<RuleTarget, 'to' | 'phrase'> | null | undefined): string {
  const mine = n.to.map((k) => (k === 'managers' ? tx('rules.words.theProjectSManagers') : ofTarget(t, k)));
  return listWords([...mine, ...n.people.map((p) => `@${p}`)]) || tx('rules.words.nobody');
}

/** "all of its subtasks match #Unresolved": who matches, and the query, in the order the language says them. */
export function relatedMatch(r: Pick<RuleRelated, 'of' | 'phrase' | 'match'>, query: ReactNode): ReactNode {
  const all = r.match !== 'any';
  const v = r.phrase?.trim() || tx('rules.words.isLinkedTo');
  switch (r.of) {
    case 'parent':
      return tr('rules.words.itsParentMatchesQuery', { query });
    case 'subtasks':
      return tr(all ? 'rules.words.allItsSubtasksMatchQuery' : 'rules.words.anyItsSubtasksMatchesQuery', { query });
    case 'siblings':
      return tr(all ? 'rules.words.allItsSiblingsMatchQuery' : 'rules.words.anyItsSiblingsMatchesQuery', { query });
    case 'linked':
      return tr(all ? 'rules.words.allLinkedMatchQuery' : 'rules.words.anyLinkedMatchesQuery', { v, query });
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
  const on = targetOf(rule.target);
  if (!rule.script?.trim() && (rule.command || comment)) {
    const code = rule.command ? <code>{rule.command}</code> : null;
    out.push(
      <>
        {rule.command && comment
          ? tr('rules.words.applyAndCommentTo', { code: code, short: short(comment, 80), ...on })
          : rule.command
            ? tr('rules.words.applyTo', { code: code, ...on })
            : tr('rules.words.commentOn', { short: short(comment ?? '', 80), ...on })}
      </>,
    );
  }
  if (rule.notify) out.push(<>{tr('rules.words.tell', { recipientWords: recipientWords(rule.notify, rule.target), short: short(rule.notify.message, 120) })}</>);
  if (rule.call) {
    // About the issues it reaches when nothing else names them.
    const about = !rule.command && !comment ? on : { target: 'none', phrase: '' };
    out.push(<>{tr('rules.words.callAbout', { v: rule.call.origin ?? tx('rules.words.aWebhook'), t0: (c: ReactNode) => <span className="mono">{c}</span>, ...about })}</>);
  }
  return out;
}

/** What a rule does, as its language lists things; "do nothing" when nothing. */
function thenWords(rule: Parts): ReactNode {
  const parts = actions(rule);
  return parts.length ? listNodes(parts) : tx('rules.words.doNothing');
}

/** No full stop after a quoted message that ends one already, as the server says it. */
function stops(rule: Parts): boolean {
  if (rule.call || !rule.notify) return true;
  return !/[.!?…]$/.test(short(rule.notify.message.trim(), 120));
}

function Related({ rule }: { rule: Parts }) {
  const r = rule.related;
  if (!r?.query.trim()) return null;
  return <>{relatedMatch(r, <code>{r.query}</code>)}</>;
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
  // One sentence a language can order as it says it (D49). Which condition it has is a code its message
  // words: a query, a related issues' one, both, or none.
  const values = {
    t0: (c: ReactNode) => <span className="rule-word">{c}</span>,
    cond: query && related ? 'both' : query ? 'query' : related ? 'related' : 'none',
    query: query ? <code>{query}</code> : '',
    related: related ?? '',
    actions: thenWords(rule),
    stop: stops(rule) ? 'yes' : 'no',
  };
  if (rule.kind === 'schedule') return <p className="rule-sentence">{tr('rules.words.scheduleSentence', { ...values, schedule: scheduleWords(rule.schedule) })}</p>;
  return <p className="rule-sentence">{tr('rules.words.whenSentence', { ...values, trigger: triggerWords(rule.trigger, rule.field) })}</p>;
}

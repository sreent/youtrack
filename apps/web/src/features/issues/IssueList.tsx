import type { Issue } from '@a4a/shared';
import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { Link, useNavigate } from 'react-router';
import { ago, optionOf, PriorityMeter, StateBadge } from '../../components/Badges';
import { Icon } from '../../components/Icon';
import { Who } from '../../components/Who';
import { userOf } from './fields';
import { intlLocale, t, tr } from '../../i18n';

/** A group of a grouped list (D72): its head, and its issues on this page. */
export interface IssueListGroup {
  /** What it's kept by when folded: the group's value, or a mark of its own for the issues with none. */
  key: string;
  /** The head's words: the value as the rows show it, a badge where it has a tone. */
  name: ReactNode;
  /** The same in words alone, for its rows' name. */
  label: string;
  /** The group of the issues with no value, drawn muted. */
  none: boolean;
  /** How many the whole result holds, not only this page. */
  count: number;
  issues: Issue[];
}

interface Props {
  issues: Issue[];
  label: string;
  chosen: Set<string>;
  onChosen: (next: Set<string>) => void;
  onCommand: () => void;
  /** The issue open beside the list, if any. */
  current?: string;
  /** In groups, each under a head that folds it: the page's issues, group by group. */
  groups?: IssueListGroup[];
  /** The groups folded, by key. */
  folded?: Set<string>;
  onFold?: (key: string, folded: boolean) => void;
}

/**
 * Ocean's IssueList: dense rows, chosen with a box; from the keyboard, one stop with the arrows inside.
 * In groups, each head is a stop of its own that folds its group, and the arrows go past folded rows.
 */
export function IssueList({ issues, label, chosen, onChosen, onCommand, current, groups, folded, onFold }: Props) {
  const navigate = useNavigate();
  const baseId = useId();
  const [focus, setFocus] = useState(0);
  const rows = useRef(new Map<string, HTMLLIElement | null>());
  const all = useRef<HTMLInputElement>(null);
  const ids = issues.map((i) => i.id);
  const chosenHere = ids.filter((id) => chosen.has(id)).length;
  // The rows the arrows reach: every row, less those of a folded group.
  const reachable = groups ? groups.flatMap((g) => (folded?.has(g.key) ? [] : g.issues)) : issues;

  useEffect(() => {
    if (all.current) all.current.indeterminate = chosenHere > 0 && chosenHere < ids.length;
  }, [chosenHere, ids.length]);
  useEffect(() => {
    if (focus >= reachable.length) setFocus(Math.max(0, reachable.length - 1));
  }, [reachable.length, focus]);

  const toggle = (id: string) => {
    const next = new Set(chosen);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    onChosen(next);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLLIElement>, i: number, id: string) => {
    if (e.target !== e.currentTarget) return; // a control inside the row has its own keys
    const to = ({ ArrowDown: i + 1, ArrowUp: i - 1, Home: 0, End: reachable.length - 1 } as Record<string, number>)[e.key];
    if (to !== undefined) {
      e.preventDefault();
      if (to >= 0 && to < reachable.length) {
        setFocus(to);
        rows.current.get(reachable[to]!.id)?.focus();
      }
    } else if (e.key === ' ') {
      e.preventDefault();
      toggle(id);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      navigate(`/issues/${id}`);
    }
  };

  const row = (issue: Issue) => {
    const i = reachable.indexOf(issue);
    const type = optionOf(issue.fields, 'Type');
    const assignee = userOf(issue.fields, 'Assignee');
    return (
      <li
        key={issue.uid}
        ref={(el) => {
          rows.current.set(issue.id, el);
        }}
        className={issue.resolvedAt ? 'issue resolved' : 'issue'}
        tabIndex={i === focus ? 0 : -1}
        aria-current={issue.id === current ? 'true' : undefined}
        onFocus={() => i >= 0 && setFocus(i)}
        onKeyDown={(e) => onKeyDown(e, i, issue.id)}
      >
        {/* Its label is the box's target: on a touch screen, 44px around it (D47). */}
        <label className="issue-pick">
          <input type="checkbox" className="issue-select" aria-label={t('issues.issueList.choose', { id: issue.id })} tabIndex={-1} checked={chosen.has(issue.id)} onChange={() => toggle(issue.id)} />
        </label>
        <span className="issue-id">{issue.id}</span>
        <span className="issue-main">
          <Link className="issue-summary" to={`/issues/${issue.id}`} tabIndex={-1}>
            {issue.summary}
          </Link>
          {issue.tags.length ? (
            <span className="chips">
              {issue.tags.map((t) => (
                <span key={t.id} className="chip">
                  {t.name}
                </span>
              ))}
            </span>
          ) : null}
        </span>
        <span className="issue-meta">
          <span className="issue-state">
            <StateBadge fields={issue.fields} />
          </span>
          <span className="issue-priority">
            <PriorityMeter fields={issue.fields} />
          </span>
          <span className="issue-type">{type?.name ?? ''}</span>
          <span className="issue-assignee">
            {assignee ? <Who kind={assignee.isBot ? 'agent' : 'person'} name={assignee.isBot ? assignee.login : assignee.name} small /> : <span className="issue-type">{t('issues.issueList.unassigned')}</span>}
          </span>
          <span className="issue-comments">
            <Icon name="chat" />
            {issue.commentCount}
            <span className="hidden">{t('issues.issueList.comments2')}</span>
          </span>
        </span>
        <time className="issue-updated" dateTime={issue.updatedAt} title={new Date(issue.updatedAt).toLocaleString(intlLocale())}>
          {ago(issue.updatedAt)}
        </time>
      </li>
    );
  };

  return (
    <section className="issues-box" aria-label={label}>
      {chosenHere > 0 ? (
        <div className="issues-bar">
          <strong>{tr('issues.issueList.chosen', { chosenHere: chosenHere })}</strong>
          <button type="button" onClick={onCommand}>{t('issues.issueList.applyACommand')}</button>
          <button type="button" className="link" onClick={() => onChosen(new Set([...chosen].filter((id) => !ids.includes(id))))}>{t('issues.issueList.chooseNone')}</button>
        </div>
      ) : null}
      <div className="issues-head">
        <input
          ref={all}
          type="checkbox"
          aria-label={t('issues.issueList.chooseAllIssues', { length: issues.length })}
          checked={issues.length > 0 && chosenHere === issues.length}
          onChange={(e) => onChosen(e.target.checked ? new Set([...chosen, ...ids]) : new Set([...chosen].filter((id) => !ids.includes(id))))}
        />
        <span>{t('issues.issueList.issue')}</span>
        <span>{t('issues.issueList.state')}</span>
        <span>{t('issues.issueList.priority')}</span>
        <span>{t('issues.issueList.type')}</span>
        <span>{t('issues.issueList.assignee')}</span>
        <span>
          <span className="hidden">{t('issues.issueList.comments')}</span>
        </span>
        <span>{t('issues.issueList.updated')}</span>
      </div>
      {groups ? (
        groups.map((g, n) => {
          const id = `${baseId}-g${n}`;
          const isFolded = Boolean(folded?.has(g.key));
          return (
            <section key={g.key} className="issues-group" aria-labelledby={`${id}-head`}>
              <h3 className="issues-group-head" id={`${id}-head`}>
                <button type="button" className="issues-group-fold" aria-expanded={!isFolded} aria-controls={`${id}-rows`} onClick={() => onFold?.(g.key, !isFolded)}>
                  <Icon name="chevron" />
                  <span className={g.none ? 'issues-group-name none' : 'issues-group-name'}>{g.name}</span>
                  <span className="issues-group-count">
                    <span aria-hidden="true">{g.count}</span>
                    <span className="hidden">{t('count.issues', { n: g.count })}</span>
                  </span>
                </button>
              </h3>
              <ul className="issues" id={`${id}-rows`} aria-label={g.label} hidden={isFolded}>
                {g.issues.map(row)}
              </ul>
            </section>
          );
        })
      ) : (
        <ul className="issues" aria-label={t('count.issues', { n: issues.length })}>
          {issues.map(row)}
        </ul>
      )}
    </section>
  );
}

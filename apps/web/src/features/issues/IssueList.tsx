import type { Issue } from '@a4a/shared';
import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { ago, optionOf, PriorityMeter, StateBadge } from '../../components/Badges';
import { Icon } from '../../components/Icon';
import { Who } from '../../components/Who';
import { userOf } from './fields';
import { intlLocale, t, tr } from '../../i18n';

interface Props {
  issues: Issue[];
  label: string;
  chosen: Set<string>;
  onChosen: (next: Set<string>) => void;
  onCommand: () => void;
  /** The issue open beside the list, if any. */
  current?: string;
}

/** Ocean's IssueList: dense rows, chosen with a box; from the keyboard, one stop with the arrows inside. */
export function IssueList({ issues, label, chosen, onChosen, onCommand, current }: Props) {
  const navigate = useNavigate();
  const [focus, setFocus] = useState(0);
  const rows = useRef<(HTMLLIElement | null)[]>([]);
  const all = useRef<HTMLInputElement>(null);
  const ids = issues.map((i) => i.id);
  const chosenHere = ids.filter((id) => chosen.has(id)).length;

  useEffect(() => {
    if (all.current) all.current.indeterminate = chosenHere > 0 && chosenHere < ids.length;
  }, [chosenHere, ids.length]);
  useEffect(() => {
    if (focus >= issues.length) setFocus(Math.max(0, issues.length - 1));
  }, [issues.length, focus]);

  const toggle = (id: string) => {
    const next = new Set(chosen);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    onChosen(next);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLLIElement>, i: number, id: string) => {
    if (e.target !== e.currentTarget) return; // a control inside the row has its own keys
    const to = ({ ArrowDown: i + 1, ArrowUp: i - 1, Home: 0, End: issues.length - 1 } as Record<string, number>)[e.key];
    if (to !== undefined) {
      e.preventDefault();
      if (to >= 0 && to < issues.length) {
        setFocus(to);
        rows.current[to]?.focus();
      }
    } else if (e.key === ' ') {
      e.preventDefault();
      toggle(id);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      navigate(`/issues/${id}`);
    }
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
      <ul className="issues" aria-label={t('count.issues', { n: issues.length })}>
        {issues.map((issue, i) => {
          const type = optionOf(issue.fields, 'Type');
          const assignee = userOf(issue.fields, 'Assignee');
          return (
            <li
              key={issue.uid}
              ref={(el) => {
                rows.current[i] = el;
              }}
              className={issue.resolvedAt ? 'issue resolved' : 'issue'}
              tabIndex={i === focus ? 0 : -1}
              aria-current={issue.id === current ? 'true' : undefined}
              onFocus={() => setFocus(i)}
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
        })}
      </ul>
    </section>
  );
}

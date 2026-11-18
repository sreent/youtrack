/**
 * Moving, cloning, votes and reactions on an issue (D41).
 */
import type { IssueDetail, MovePlan, Project, ReactionSummary, Vote } from '@a4a/shared';
// The constants alone: the package's root brings zod, whose first parse tries eval, which the CSP refuses.
import { REACTIONS } from '@a4a/shared/constants';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useId, useState } from 'react';
import { useNavigate } from 'react-router';
import { ApiError, del, get, post } from '../../api/client';
import { keys } from '../../api/queries';
import { ErrorLine } from '../../components/States';
import { errorText } from './api';
import { formatList, problemSaid, t, tr } from '../../i18n';
import type { ReactNode } from 'react';

function useRefresh(issue: string) {
  const qc = useQueryClient();
  return () =>
    Promise.all([
      qc.invalidateQueries({ queryKey: keys.issue(issue) }),
      qc.invalidateQueries({ queryKey: ['issues', 'one', issue] }),
      qc.invalidateQueries({ queryKey: ['issues', 'list'] }),
    ]);
}

/** Vote for it, or take the vote back; its reporter has said so already. */
export function VoteToggle({ issue, mine }: { issue: IssueDetail; mine: boolean }) {
  const refresh = useRefresh(issue.id);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const toggle = async () => {
    setBusy(true);
    setError('');
    try {
      if (issue.voted) await del(`/issues/${issue.id}/vote`);
      else await post<Vote>(`/issues/${issue.id}/vote`);
      await refresh();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <button
        type="button"
        className="watch vote"
        aria-pressed={issue.voted}
        disabled={busy || mine}
        onClick={() => void toggle()}
        title={mine ? t('issues.moves.youReportedItSoYou') : issue.voted ? t('issues.moves.youVotedForItPress') : t('issues.moves.voteForItSayYou')}
      >
        <span aria-hidden="true">▲</span>
        <span>{t('issues.moves.vote')}</span>
        <span className="watch-count">
          <span aria-hidden="true">{issue.votes}</span>
          <span className="hidden">, {issue.votes === 1 ? t('issues.moves.n1Vote') : t('issues.moves.votes', { votes: issue.votes })}</span>
        </span>
      </button>
      {error ? <ErrorLine>{error}</ErrorLine> : null}
    </>
  );
}

/** Reactions to a description or a comment: each with how many and who, and the set to add from. */
export function ReactionBar({ reactions, path, issue, canReact }: { reactions: ReactionSummary[]; path: string; issue: string; canReact: boolean }) {
  const refresh = useRefresh(issue);
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [error, setError] = useState('');
  const menuId = useId();
  const toggle = async (emoji: string) => {
    setOpen(false);
    setError('');
    try {
      await post<ReactionSummary[]>(path, { emoji });
      await refresh();
      await qc.invalidateQueries({ queryKey: keys.issueSub(issue, 'comments') });
    } catch (e) {
      setError(errorText(e));
    }
  };
  if (!reactions.length && !canReact) return null;
  return (
    <div className="reactions" aria-label={t('issues.moves.reactions')}>
      {reactions.map((r) => (
        <button
          key={r.emoji}
          type="button"
          className="reaction"
          aria-pressed={r.mine}
          disabled={!canReact}
          title={formatList(r.people.map((p) => p.name))}
          onClick={() => void toggle(r.emoji)}
        >
          {r.emoji} {r.count}
          <span className="hidden"> {t('issues.moves.reactionCount', { n: r.count })}{r.mine ? t('issues.moves.yoursAmongThem') : ''}</span>
        </button>
      ))}
      {canReact ? (
        <span className="reaction-add">
          <button type="button" className="reaction" aria-expanded={open} aria-controls={menuId} onClick={() => setOpen(!open)} title={t('issues.moves.react')}>
            <span aria-hidden="true">☺+</span>
            <span className="hidden">{t('issues.moves.react')}</span>
          </button>
          {open ? (
            <span className="reaction-menu" id={menuId} role="group" aria-label={t('issues.moves.chooseAReaction')}>
              {REACTIONS.map((e) => (
                <button key={e} type="button" className="reaction" onClick={() => void toggle(e)}>
                  {e}
                </button>
              ))}
            </span>
          ) : null}
        </span>
      ) : null}
      {error ? <ErrorLine>{error}</ErrorLine> : null}
    </div>
  );
}

/** Copy it, here or into another project, and go to the copy. */
export function CloneButton({ issue }: { issue: IssueDetail }) {
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const clone = async () => {
    setBusy(true);
    setError('');
    try {
      const copy = await post<IssueDetail>(`/issues/${issue.id}/clone`, {});
      navigate(`/issues/${copy.id}`);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <button type="button" disabled={busy} onClick={() => void clone()} title={t('issues.moves.aNewIssueWithIts')}>
        {busy ? t('issues.moves.cloning') : t('issues.moves.clone')}
      </button>
      {error ? <ErrorLine>{error}</ErrorLine> : null}
    </>
  );
}

/** Move it to another project: what carries over and what doesn't, asked for before anything moves. */
export function MoveIssue({ issue, onClose }: { issue: IssueDetail; onClose: () => void }) {
  const navigate = useNavigate();
  const projects = useQuery({ queryKey: ['projects', 'list'], queryFn: () => get<Project[]>('/projects') });
  const choices = (projects.data ?? []).filter((p) => p.key !== issue.project.key && !p.archived && (p.access?.write ?? true));
  const [project, setProject] = useState('');
  const [values, setValues] = useState<Record<string, string | null>>({});
  const [plan, setPlan] = useState<MovePlan | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const ask = async (dryRun: boolean, key = project, fields = values) => {
    if (!key) return;
    setBusy(true);
    setError('');
    try {
      const res = await post<MovePlan>(`/issues/${issue.id}/move`, { project: key, fields, dryRun });
      setPlan(res);
      if (res.moved) navigate(`/issues/${res.to}`, { replace: true });
    } catch (e) {
      if (e instanceof ApiError && (e.details as MovePlan | undefined)?.problems) setPlan(e.details as MovePlan);
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  const open = (plan?.problems ?? []).filter((p) => p.field && !(p.field in values));
  return (
    <section className="card stack" aria-label={t('issues.moves.move', { id: issue.id })}>
      <h2>{tr('issues.moves.moveToAnotherProject', { id: issue.id })}</h2>
      <label className="form-field">
        <span>{t('issues.moves.project')}</span>
        <select
          value={project}
          onChange={(e) => {
            setProject(e.target.value);
            setValues({});
            setPlan(null);
            void ask(true, e.target.value, {});
          }}
        >
          <option value="">{t('issues.moves.chooseAProject')}</option>
          {choices.map((p) => (
            <option key={p.key} value={p.key}>
              {p.name} ({p.key})
            </option>
          ))}
        </select>
      </label>
      {plan ? (
        <>
          <p className="note">{tr('issues.moves.itBecomesWillStillFind', { to: plan.to, t0: (c: ReactNode) => <strong>{c}</strong>, id: issue.id })}</p>
          {plan.problems.map((p) =>
            p.field ? (
              <label key={p.field} className="form-field">
                <span>{problemSaid(p) ?? p.message}</span>
                <select
                  value={values[p.field] === undefined ? '' : (values[p.field] ?? '-')}
                  onChange={(e) => {
                    const next = { ...values, [p.field!]: e.target.value === '-' ? null : e.target.value };
                    setValues(next);
                    void ask(true, project, next);
                  }}
                >
                  <option value="">{t('issues.moves.choose')}</option>
                  <option value="-">{t('issues.moves.leaveItEmpty')}</option>
                  {(p.choices ?? []).map((c) => (
                    <option key={c} value={c}>
                      {c}
                    </option>
                  ))}
                </select>
              </label>
            ) : (
              <ErrorLine key={p.message}>{problemSaid(p) ?? p.message}</ErrorLine>
            ),
          )}
          {plan.carried.length ? (
            <ul className="plain">
              {plan.carried.map((c) => (
                <li key={c.field}>
                  {t('issues.moves.carried', { field: c.field, same: c.from === c.to ? 'yes' : 'no', from: c.from ?? t('common.changeLines.none'), to: c.to ?? t('common.changeLines.none') })}
                </li>
              ))}
            </ul>
          ) : null}
          {plan.dropped.length ? <p className="note">{tr('issues.moves.leftBehindAsDoesnT', { key: plan.project.key, join: formatList(plan.dropped) })}</p> : null}
          {plan.leftSprints.length ? <p className="note">{tr('issues.moves.itLeaves', { join: formatList(plan.leftSprints) })}</p> : null}
        </>
      ) : null}
      {error && !plan?.problems.length ? <ErrorLine>{error}</ErrorLine> : null}
      <div className="cluster">
        <button type="button" className="primary" disabled={!project || busy || open.length > 0 || Boolean(plan?.problems.some((p) => !p.field))} onClick={() => void ask(false)}>
          {busy ? t('issues.moves.moving') : t('issues.moves.move2')}
        </button>
        <button type="button" onClick={onClose}>{t('issues.moves.cancel')}</button>
      </div>
    </section>
  );
}

/**
 * Moving, cloning, votes and reactions on an issue (D41).
 */
import { REACTIONS, type IssueDetail, type MovePlan, type Project, type ReactionSummary, type Vote } from '@a4a/shared';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useId, useState } from 'react';
import { useNavigate } from 'react-router';
import { ApiError, del, get, post } from '../../api/client';
import { keys } from '../../api/queries';
import { ErrorLine } from '../../components/States';
import { errorText } from './api';

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
        title={mine ? 'You reported it, so your vote is counted already.' : issue.voted ? 'You voted for it. Press to take the vote back.' : 'Vote for it: say you want it too.'}
      >
        <span aria-hidden="true">▲</span>
        <span>Vote</span>
        <span className="watch-count">
          <span aria-hidden="true">{issue.votes}</span>
          <span className="hidden">, {issue.votes === 1 ? '1 vote' : `${issue.votes} votes`}</span>
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
    <div className="reactions" aria-label="Reactions">
      {reactions.map((r) => (
        <button
          key={r.emoji}
          type="button"
          className="reaction"
          aria-pressed={r.mine}
          disabled={!canReact}
          title={r.people.map((p) => p.name).join(', ')}
          onClick={() => void toggle(r.emoji)}
        >
          <span aria-hidden="true">{r.emoji}</span> {r.count}
          <span className="hidden"> {r.count === 1 ? 'reaction' : 'reactions'}{r.mine ? ', yours among them' : ''}</span>
        </button>
      ))}
      {canReact ? (
        <span className="reaction-add">
          <button type="button" className="reaction" aria-expanded={open} aria-controls={menuId} onClick={() => setOpen(!open)} title="React">
            <span aria-hidden="true">☺+</span>
            <span className="hidden">React</span>
          </button>
          {open ? (
            <span className="reaction-menu" id={menuId} role="group" aria-label="Choose a reaction">
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
      <button type="button" disabled={busy} onClick={() => void clone()} title="A new issue with its summary, description, values and tags, linked back to this one">
        {busy ? 'Cloning…' : 'Clone'}
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
    <section className="card stack" aria-label={`Move ${issue.id}`}>
      <h2>Move {issue.id} to another project</h2>
      <label className="form-field">
        <span>Project</span>
        <select
          value={project}
          onChange={(e) => {
            setProject(e.target.value);
            setValues({});
            setPlan(null);
            void ask(true, e.target.value, {});
          }}
        >
          <option value="">Choose a project</option>
          {choices.map((p) => (
            <option key={p.key} value={p.key}>
              {p.name} ({p.key})
            </option>
          ))}
        </select>
      </label>
      {plan ? (
        <>
          <p className="note">
            It becomes <strong>{plan.to}</strong>; {issue.id} will still find it.
          </p>
          {plan.problems.map((p) =>
            p.field ? (
              <label key={p.field} className="form-field">
                <span>{p.message}</span>
                <select
                  value={values[p.field] === undefined ? '' : (values[p.field] ?? '-')}
                  onChange={(e) => {
                    const next = { ...values, [p.field!]: e.target.value === '-' ? null : e.target.value };
                    setValues(next);
                    void ask(true, project, next);
                  }}
                >
                  <option value="">Choose…</option>
                  <option value="-">Leave it empty</option>
                  {(p.choices ?? []).map((c) => (
                    <option key={c} value={c}>
                      {c}
                    </option>
                  ))}
                </select>
              </label>
            ) : (
              <ErrorLine key={p.message}>{p.message}</ErrorLine>
            ),
          )}
          {plan.carried.length ? (
            <ul className="plain">
              {plan.carried.map((c) => (
                <li key={c.field}>
                  {c.field}: {c.from === c.to ? (c.to ?? 'empty') : `${c.from ?? 'empty'} → ${c.to ?? 'empty'}`}
                </li>
              ))}
            </ul>
          ) : null}
          {plan.dropped.length ? <p className="note">Left behind, as {plan.project.key} doesn't have them: {plan.dropped.join(', ')}.</p> : null}
          {plan.leftSprints.length ? <p className="note">It leaves {plan.leftSprints.join(', ')}.</p> : null}
        </>
      ) : null}
      {error && !plan?.problems.length ? <ErrorLine>{error}</ErrorLine> : null}
      <div className="cluster">
        <button type="button" className="primary" disabled={!project || busy || open.length > 0 || Boolean(plan?.problems.some((p) => !p.field))} onClick={() => void ask(false)}>
          {busy ? 'Moving…' : 'Move'}
        </button>
        <button type="button" onClick={onClose}>
          Cancel
        </button>
      </div>
    </section>
  );
}

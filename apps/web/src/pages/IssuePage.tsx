import type { IssueDetail, IssueField, Suggestion, User } from '@a4a/shared';
import { toggleTask } from '@a4a/shared/markdown';
import { useQueryClient } from '@tanstack/react-query';
import { useMemo, useState, useEffect } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { ApiError, post } from '../api/client';
import { keys, useAIStatus, useIssue, useMe, useMembers, useProject, useProjectFields, useSuggestions, useUsers } from '../api/queries';
import { StateBadge } from '../components/Badges';
import { Icon } from '../components/Icon';
import { Markdown } from '../components/Markdown';
import { ErrorNote, Loading, PageHead, ErrorLine } from '../components/States';
import { Who } from '../components/Who';
import { SuggestionCard } from '../features/decide/SuggestionCard';
import { errorText, useUpdateIssue } from '../features/issues/api';
import { CommandBar } from '../features/issues/CommandBar';
import { FieldPanel, type Proposal } from '../features/issues/FieldPanel';
import { isOption, isPeriod, isUser } from '../features/issues/fields';
import { IssueHistory } from '../features/issues/IssueHistory';
import { IssueLinks } from '../features/issues/IssueLinks';
import { WorkLog } from '../features/issues/WorkLog';
import { IssueFiles } from '../features/attachments/IssueFiles';
import { IssueArticles } from '../features/articles/IssueArticles';
import { IssueCode } from '../features/vcs/IssueCode';
import { FormField } from '../components/Form';
import { RequestCard, SlaBadge } from '../features/helpdesk/RequestCard';
import { WatchersCard, WatchToggle } from '../features/issues/Watching';
import { CloneButton, MoveIssue, ReactionBar, VoteToggle } from '../features/issues/Moves';
import { VisibleToCard } from '../features/issues/VisibleTo';
import { useRequestInfo } from '../features/notifications/api';
import { useProjectGroups } from '../features/groups/api';
import { WorkflowBar } from '../features/workflow/WorkflowBar';
import { AppWidgets } from '../features/apps/AppWidgets';
import { attachmentKeys } from '../features/attachments/api';
import { RichField } from '../features/editor/RichField';

/** A field's value as triage writes it: a login for a person, the words for a period. */
function presented(f: IssueField | undefined): string | null {
  const v = f?.value;
  if (v === null || v === undefined) return null;
  if (Array.isArray(v)) return v.map((x) => (isUser(x) ? x.login : x.name)).join(', ') || null;
  if (isUser(v)) return v.login;
  if (isPeriod(v)) return v.presentation;
  if (isOption(v)) return v.name;
  return String(v);
}

const open = (s: Suggestion) => s.status === 'pending' || s.status === 'partially_applied';

/**
 * The issue's description: read, with its checklist ticked in place by who may change the issue
 * (saved against the version read: a change made meanwhile says so and reloads); or written in
 * the editor, where a pasted picture becomes one of the issue's files, in the text (D39).
 */
function Description({ issue, canEdit, canReact, people }: { issue: IssueDetail; canEdit: boolean; canReact: boolean; people?: User[] }) {
  const qc = useQueryClient();
  const update = useUpdateIssue(issue);
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(issue.description);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // A box ticked shows ticked while it's saved.
  const [ticked, setTicked] = useState<string | null>(null);

  const tick = async (index: number, checked: boolean) => {
    const next = toggleTask(issue.description, index, checked);
    if (next === null) return;
    setError(null);
    setTicked(next);
    try {
      await update({ description: next });
    } catch (err) {
      setError(errorText(err));
    } finally {
      setTicked(null);
    }
  };

  if (editing) {
    return (
      <form
        className="card form"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setError(null);
          try {
            await update({ description: text });
            setEditing(false);
          } catch (err) {
            setError(errorText(err));
          } finally {
            setBusy(false);
          }
        }}
      >
        <FormField label="Description">
          {(id) => (
            <RichField
              id={id}
              label="Description"
              value={text}
              onChange={setText}
              rows={10}
              tall
              autoFocus
              people={people}
              uploadTo={`/issues/${issue.id}/attachments`}
              onUploaded={() => void qc.invalidateQueries({ queryKey: attachmentKeys.issue(issue.id) })}
            />
          )}
        </FormField>
        {error ? <ErrorLine>{error}</ErrorLine> : null}
        <div className="cluster end">
          <button type="button" onClick={() => setEditing(false)}>
            Cancel
          </button>
          <button type="submit" className="primary" disabled={busy}>
            {busy ? 'Saving…' : 'Save'}
          </button>
        </div>
      </form>
    );
  }
  return (
    <section className="card stack" aria-label="Description">
      {issue.description.trim() ? (
        <Markdown text={ticked ?? issue.description} onToggleTask={canEdit && ticked === null ? (i, on) => void tick(i, on) : undefined} />
      ) : (
        <p className="note">No description yet.</p>
      )}
      {error ? <ErrorLine>{error}</ErrorLine> : null}
      <ReactionBar reactions={issue.reactions} path={`/issues/${issue.id}/reactions`} issue={issue.id} canReact={canReact} />
      {canEdit ? (
        <div className="cluster">
          <button
            type="button"
            className="link"
            onClick={() => {
              setText(issue.description);
              setError(null);
              setEditing(true);
            }}
          >
            Edit the description
          </button>
        </div>
      ) : null}
    </section>
  );
}

function Summary({ issue }: { issue: IssueDetail }) {
  const [state, setState] = useState<{ text: string } | { error: string } | 'asking' | null>(null);
  const ask = async () => {
    setState('asking');
    try {
      const r = await post<{ summary: string }>(`/issues/${issue.id}/summarize`);
      setState({ text: r.summary });
    } catch (e) {
      setState({ error: errorText(e, 'The assistant couldn’t summarise this issue.') });
    }
  };
  if (state === null)
    return (
      <button type="button" onClick={() => void ask()}>
        Summarise
      </button>
    );
  return (
    <section className="card stack" aria-label="Summary by the assistant">
      <div className="cluster">
        <Who kind="agent" name="assistant" small />
        <span className="note">summarised the issue and its discussion</span>
      </div>
      {state === 'asking' ? <p className="note">Reading the issue…</p> : 'text' in state ? <Markdown text={state.text} /> : <ErrorLine>{state.error}</ErrorLine>}
    </section>
  );
}

/** The summary, changed in place by someone who may change the issue; for anyone else, its words. */
function Title({ issue, canEdit }: { issue: IssueDetail; canEdit: boolean }) {
  const update = useUpdateIssue(issue);
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(issue.summary);
  const [error, setError] = useState<string | null>(null);
  if (!canEdit) return <>{issue.summary}</>;
  if (!editing)
    return (
      <span
        className="editable"
        role="button"
        tabIndex={0}
        title="Change the summary"
        aria-label={`${issue.summary}. Change the summary`}
        onClick={() => {
          setText(issue.summary);
          setEditing(true);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            setText(issue.summary);
            setEditing(true);
          }
        }}
      >
        {issue.summary}
      </span>
    );
  return (
    <form
      className="cluster"
      onSubmit={async (e) => {
        e.preventDefault();
        if (!text.trim()) return;
        try {
          await update({ summary: text.trim() });
          setEditing(false);
          setError(null);
        } catch (err) {
          setError(errorText(err));
        }
      }}
    >
      <input className="grow" aria-label="Summary" value={text} onChange={(e) => setText(e.target.value)} autoFocus onKeyDown={(e) => e.key === 'Escape' && setEditing(false)} />
      <button type="submit" className="primary">
        Save
      </button>
      <button type="button" onClick={() => setEditing(false)}>
        Cancel
      </button>
      {error ? <ErrorLine>{error}</ErrorLine> : null}
    </form>
  );
}

export default function IssuePage() {
  const { id = '' } = useParams();
  const qc = useQueryClient();
  const issue = useIssue(id);
  const me = useMe();
  const ai = useAIStatus();
  const users = useUsers();
  const projectFields = useProjectFields(issue.data?.project.key);
  const project = useProject(issue.data?.project.key);
  const membersOnly = project.data?.visibility === 'members';
  const members = useMembers(membersOnly ? project.data?.key : undefined);
  const groups = useProjectGroups(membersOnly ? (project.data?.key ?? '') : '', membersOnly);
  // In a members-only project, only its people, the people in its groups (D27) and administrators can be given its issues.
  const assignable = useMemo(() => {
    if (!users.data || (membersOnly && (!members.data || !groups.data))) return undefined;
    if (!membersOnly) return users.data;
    const logins = new Set([...(members.data ?? []).map((m) => m.user.login), ...(groups.data ?? []).flatMap((g) => g.people.map((p) => p.login))]);
    return users.data.filter((u) => u.role === 'admin' || logins.has(u.login));
  }, [users.data, members.data, groups.data, membersOnly]);
  const suggestions = useSuggestions(id, Boolean(issue.data));
  const request = useRequestInfo(issue.data);
  const [commanding, setCommanding] = useState(false);
  const [moving, setMoving] = useState(false);
  const navigate = useNavigate();
  // An id it had before it moved finds it; the address then says the id it has now (D41).
  const asked = id.toUpperCase();
  const movedFrom = issue.data && issue.data.id !== asked && issue.data.formerIds.includes(asked) ? asked : null;
  useEffect(() => {
    if (movedFrom && issue.data) navigate(`/issues/${issue.data.id}${window.location.hash}`, { replace: true, state: { movedFrom } });
  }, [movedFrom, issue.data, navigate]);
  const [triaging, setTriaging] = useState<string | null>(null);

  // Each field's value as triage last worked it out, while it differs from the issue's own.
  const openSuggestions = useMemo(() => (suggestions.data ?? []).filter(open), [suggestions.data]);
  const proposals = useMemo(() => {
    const out = new Map<string, Proposal>();
    const data = issue.data;
    if (!data) return out;
    for (const s of openSuggestions) {
      for (const f of s.payload.fields) {
        if (out.has(f.name)) continue;
        const now = presented(data.fields.find((x) => x.name === f.name));
        if (f.value === now) continue;
        out.set(f.name, {
          value: f.value,
          reason: f.reason,
          accept: async () => {
            await post(`/suggestions/${s.id}/apply`, { fields: [f.name] });
            await Promise.all([
              qc.invalidateQueries({ queryKey: keys.issue(data.id) }),
              qc.invalidateQueries({ queryKey: ['issues', 'one', data.id] }),
              qc.invalidateQueries({ queryKey: ['ai'] }),
            ]);
          },
        });
      }
    }
    return out;
  }, [openSuggestions, issue.data, qc]);

  if (issue.isLoading) return <Loading what={id} />;
  if (issue.error) {
    return (
      <>
        <PageHead title={id} crumbs={<Link to="/issues">Issues</Link>} />
        {issue.error instanceof ApiError && issue.error.status === 404 ? <p className="note">There’s no issue {id}, or you can’t see it.</p> : <ErrorNote error={issue.error} />}
      </>
    );
  }
  const data = issue.data!;
  // What the project lets you do; until it's known, the page offers everything and the server decides.
  const canWrite = project.data?.access.write ?? true;
  const canComment = project.data?.access.comment ?? true;

  const triage = async () => {
    setTriaging('asking');
    try {
      await post(`/issues/${data.id}/triage`);
      await qc.invalidateQueries({ queryKey: keys.issueSub(data.id, 'suggestions') });
      setTriaging(null);
    } catch (e) {
      setTriaging(errorText(e));
    }
  };

  return (
    <>
      <PageHead
        crumbs={
          <>
            <Link to="/issues">Issues</Link> / <Link to={`/issues?q=${encodeURIComponent(`project: ${data.project.key}`)}`}>{data.project.name}</Link>
          </>
        }
        title={<Title issue={data} canEdit={canWrite} />}
        badges={
          <>
            <span className="issue-id">{data.id}</span>
            {data.formerIds.length ? <span className="note">was {data.formerIds.join(', ')}</span> : null}
            <StateBadge fields={data.fields} />
            {request.data ? <SlaBadge sla={request.data.firstResponse} since={request.data.createdAt} /> : null}
          </>
        }
        meta={
          <>
            <span>
              {request.data ? `Asked by ${request.data.requester.name} through the help desk` : `Reported by ${data.reporter?.name ?? 'someone'}`}{' '}
              <time dateTime={data.createdAt}>{new Date(data.createdAt).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })}</time>
            </span>
            {data.tags.length ? (
              <span className="chips">
                {data.tags.map((t) => (
                  <Link key={t.id} className="chip" to={`/issues?q=${encodeURIComponent(`tag: {${t.name}}`)}`}>
                    {t.name}
                  </Link>
                ))}
              </span>
            ) : null}
          </>
        }
        actions={
          <>
            <WatchToggle issue={data.id} />
            <VoteToggle issue={data} mine={Boolean(me.data && data.reporter?.id === me.data.id)} />
            {canWrite ? <CloneButton issue={data} /> : null}
            {canWrite ? (
              <button type="button" aria-expanded={moving} onClick={() => setMoving(!moving)}>
                Move
              </button>
            ) : null}
            {ai.data?.enabled ? (
              <button type="button" onClick={() => void triage()} disabled={triaging === 'asking'} title="Ask triage to work out its fields and look for duplicates">
                <Icon name="agent" />
                {triaging === 'asking' ? 'Triaging…' : 'Triage'}
              </button>
            ) : null}
            {canWrite ? (
              <button type="button" className="primary" onClick={() => setCommanding(true)}>
                <Icon name="command" />
                Apply a command
              </button>
            ) : null}
          </>
        }
      />
      {triaging && triaging !== 'asking' ? <ErrorLine>{triaging}</ErrorLine> : null}
      {moving ? <MoveIssue issue={data} onClose={() => setMoving(false)} /> : null}
      <AppWidgets at="issue-below-summary" issue={data.id} />
      {project.data && !project.data.access.write ? (
        <p className="note">
          {project.data.access.comment
            ? `You can read ${project.data.key}'s issues and comment on them; changing them is for its members.`
            : `You can read ${project.data.key}'s issues; your account doesn't change anything.`}
        </p>
      ) : null}
      <div className="split">
        <div className="stack">
          <WorkflowBar key={`workflow-${data.id}`} issue={data} canEdit={canWrite} />
          <Description issue={data} canEdit={canWrite} canReact={canComment} people={membersOnly ? (assignable ?? []) : undefined} />
          <IssueFiles key={`files-${data.id}`} issue={data} me={me.data} canEdit={canWrite} />
          {ai.data?.enabled ? <Summary issue={data} /> : null}
          {/* Deciding on what triage suggests is a change to the issue: its members decide. */}
          {canWrite ? openSuggestions.map((s) => <SuggestionCard key={s.id} suggestion={s} compact />) : null}
          <IssueLinks issue={data} canEdit={canWrite} />
          <IssueArticles issueId={data.id} />
          <IssueCode issue={data} />
          <IssueHistory
            issue={data}
            me={me.data}
            canComment={canComment}
            canReply={canWrite}
            canUndo={canWrite}
            canManage={project.data?.access.manage ?? false}
            people={membersOnly ? (assignable ?? []) : undefined}
          />
          <WorkLog issue={data} me={me.data} canEdit={canWrite} />
        </div>
        <div className="stack">
          {projectFields.data && assignable ? (
            <FieldPanel issue={data} fields={projectFields.data} users={assignable} proposals={proposals} canEdit={canWrite} />
          ) : (
            <Loading what="fields" />
          )}
          <RequestCard issue={data} />
          <VisibleToCard issue={data} canEdit={canWrite} />
          <WatchersCard issue={data.id} />
          <AppWidgets at="issue-panel" issue={data.id} />
        </div>
      </div>
      <CommandBar issues={[{ id: data.id, summary: data.summary }]} open={commanding} onClose={() => setCommanding(false)} />
    </>
  );
}

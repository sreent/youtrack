import type { Attachment, Comment, CommentVisibility, IssueDetail, TrackerEvent, UndoResult, User, UserRef } from '@a4a/shared';
import { useQueryClient } from '@tanstack/react-query';
import { useRef, useState } from 'react';
import { Link } from 'react-router';
import { toggleTask } from '@a4a/shared/markdown';
import { ApiError, patch, post } from '../../api/client';
import { attachmentKeys, formatBytes, refusal, uploadFile, useAttachmentLimits, useIssueAttachments } from '../attachments/api';
import { CommentFiles } from '../attachments/AttachmentList';
import { Icon } from '../../components/Icon';
import { keys, useActivity, useComments } from '../../api/queries';
import { Badge } from '../../components/Badges';
import { ChangeLines } from '../../components/Changes';
import { Markdown } from '../../components/Markdown';
import { ErrorNote, Loading, ErrorLine } from '../../components/States';
import { Avatar, type WhoKind } from '../../components/Who';
import { errorText } from './api';
import { ReactionBar } from './Moves';
import { FormField } from '../../components/Form';
import { Said } from '../common/bits';
import { useRequestInfo } from '../notifications/api';
import { RichField } from '../editor/RichField';
import { audience, LimitPicker, type Limit } from './VisibleTo';
import { intlLocale, t, tr } from '../../i18n';
import type { ReactNode } from 'react';

type Actor = TrackerEvent['actor'];

interface Who {
  kind: WhoKind;
  name: string;
  /** "for Anna Schmidt" when an agent or script acted for a person. */
  forWhom?: string;
  /** "via MCP", "asked in words", "on its own". */
  via: string;
}

/** Who acted, for whom and through what, in Ocean's grammar. A requester, through the help desk, by the name they gave. */
export function whoOf(actor: Actor, requester?: string | null): Who {
  const person = actor.name ?? actor.login ?? t('issues.issueHistory.someone');
  // An agent with a token of its own acts as itself, not for a person (D34).
  if (actor.isBot && (actor.channel === 'mcp' || actor.channel === 'api')) {
    return { kind: 'agent', name: actor.login ?? t('issues.issueHistory.anAgent'), via: actor.channel === 'mcp' ? t('issues.issueHistory.viaMcp') : t('issues.issueHistory.viaTheApi') };
  }
  switch (actor.channel) {
    case 'helpdesk':
      return { kind: 'person', name: requester ?? t('issues.issueHistory.theRequester'), via: t('issues.issueHistory.viaTheHelpDesk') };
    case 'web':
      return { kind: 'person', name: person, via: t('issues.issueHistory.viaTheWeb') };
    case 'chat':
      return { kind: 'person', name: person, via: t('issues.issueHistory.via', { v: actor.token ?? 'chat' }) };
    case 'api':
      return { kind: 'service', name: actor.token ?? t('issues.issueHistory.aScript'), forWhom: person, via: t('issues.issueHistory.viaTheApi') };
    case 'mcp':
      return { kind: 'agent', name: actor.token ?? t('issues.issueHistory.anAgent'), forWhom: person, via: t('issues.issueHistory.viaMcp') };
    case 'assistant':
      return { kind: 'agent', name: 'assistant', forWhom: person, via: t('issues.issueHistory.askedInWords') };
    case 'automation':
      return { kind: 'agent', name: actor.login ?? 'automation', via: t('issues.issueHistory.onItsOwn') };
    case 'email':
      return { kind: 'person', name: person, via: t('issues.issueHistory.byEmail') };
    case 'app':
      // An app's agent acting as itself (its rules), or a person through an app's widget or handler (D48).
      return actor.isBot
        ? { kind: 'agent', name: actor.name ?? actor.token ?? t('issues.issueHistory.anApp'), via: t('issues.issueHistory.anAppOnItsOwn') }
        : { kind: 'person', name: person, via: t('issues.issueHistory.viaTheApp', { v: actor.token ?? 'an' }) };
    case 'vcs':
      // A commit's author, known by a confirmed email or their login at the provider, or the integration itself.
      return actor.id
        ? { kind: 'person', name: person, via: t('issues.issueHistory.from', { v: actor.token ?? 'version control' }) }
        : { kind: 'service', name: actor.token ?? 'version control', via: t('issues.issueHistory.fromVersionControl') };
    case 'ci':
      // A build CI reported, through its build source (D46).
      return { kind: 'service', name: actor.token ?? 'CI', via: t('issues.issueHistory.fromABuild') };
    default:
      return { kind: 'own', name: 'a4a', via: '' };
  }
}

/** "applied the rule “Critical bugs go to Anna”", when a workflow rule made the change. */
function byRule(data: Record<string, unknown>): string | undefined {
  const name = (data.automation as { name?: unknown } | undefined)?.name;
  return typeof name === 'string' ? t('issues.issueHistory.appliedTheRule', { name: name }) : undefined;
}

/** Today's time alone; older ones with their day, as people read them. */
export function when(iso: string, now = new Date()): string {
  const d = new Date(iso);
  const time = d.toLocaleTimeString(intlLocale(), { hour: '2-digit', minute: '2-digit' });
  if (d.toDateString() === now.toDateString()) return time;
  const sameYear = d.getFullYear() === now.getFullYear();
  const day = d.toLocaleDateString(intlLocale(), { weekday: 'short', day: 'numeric', month: 'short', year: sameYear ? undefined : 'numeric' });
  return `${day}, ${time}`;
}

interface Entry {
  key: string;
  at: string;
  who: Who;
  did?: React.ReactNode;
  body?: React.ReactNode;
  comment?: string;
  /** A comment the requester of a help desk request sees: theirs, or the team's reply to them. */
  public?: 'reply' | 'theirs';
  /** Who a limited comment is for, besides those who always see it (D37). */
  limited?: string;
  /** A comment's own files, under its words; and its id, for links to it. */
  files?: Attachment[];
  /** The comment itself, for ticking its checklist against the version read (D39). */
  source?: Comment;
  anchor?: string;
  /** A change an agent made on its own: its event, and whether a person can undo it (D34). */
  undo?: { event: number; state: NonNullable<TrackerEvent['undo']>['state']; note: string };
  /** A comment's reactions, and its id to react to it (D41). */
  reactions?: { id: string; list: Comment['reactions'] };
}

/** "undid claude's change": whose change an undo put back, from the history it's in. */
function undid(e: TrackerEvent, byId: Map<number, TrackerEvent>, what: string): string | undefined {
  if (typeof e.data.undoes !== 'number') return undefined;
  const original = byId.get(e.data.undoes);
  return t('issues.issueHistory.undid', { v: original ? t('issues.issueHistory.s', { name: whoOf(original.actor).name }) : t('issues.issueHistory.anAgentS'), what: what });
}

function eventEntry(e: TrackerEvent, byId: Map<number, TrackerEvent>): Entry | null {
  const data = e.data as Record<string, unknown>;
  const base = {
    key: `e${e.id}`,
    at: e.occurredAt,
    who: whoOf(e.actor, (data.requester as { name?: string } | undefined)?.name),
    ...(e.undo ? { undo: { event: e.id, ...e.undo } } : {}),
  };
  switch (e.type) {
    case 'issue.created': {
      // Imported: the activity's actor ran the import; the other tracker's own dates are in it.
      const imported = data.imported as { source?: string; key?: string; createdAt?: string; reporter?: string } | undefined;
      if (imported) {
        const from = imported.source === 'jira' ? 'Jira' : imported.source === 'youtrack' ? 'YouTrack' : 'another tracker';
        const on = imported.createdAt ? t('issues.issueHistory.whereItWasReported', { when: when(imported.createdAt), v: imported.reporter ? t('issues.issueHistory.by', { reporter: imported.reporter }) : '' }) : '';
        return { ...base, did: t('issues.issueHistory.importedItFrom', { from: from, v: imported.key ?? t('issues.issueHistory.itsKeyThere'), on: on }) };
      }
      return { ...base, did: data.requester ? (data.via === 'email' ? t('issues.issueHistory.askedForHelpByEmail') : t('issues.issueHistory.askedForHelp')) : t('issues.issueHistory.reportedIt') };
    }
    case 'sprint.issue_added':
    case 'sprint.issue_removed':
      return { ...base, did: `${e.type === 'sprint.issue_added' ? t('issues.issueHistory.putItIn') : t('issues.issueHistory.tookItOutOf')} ${String(data.sprint ?? t('issues.issueHistory.aSprint'))}${data.board ? t('issues.issueHistory.on2', { String: String(data.board) }) : ''}` };
    case 'issue.updated':
      if (!e.changes.length) return null;
      return {
        ...base,
        did: undid(e, byId, 'change') ?? (data.acceptedFrom === 'triage' ? t('issues.issueHistory.acceptedWhatTriageWorkedOut') : byRule(data)),
        body: <ChangeLines changes={e.changes} />,
      };
    case 'commit.linked': {
      const sha = String(data.sha ?? '');
      const command = typeof data.command === 'string' ? data.command : null;
      return {
        ...base,
        did: (
          <>{tr('issues.issueHistory.committed', { v: typeof data.url === 'string' && /^https?:\/\//.test(data.url) ? (
              <a className="mono" href={data.url} rel="noreferrer noopener" target="_blank">
                {sha.slice(0, 7)}
              </a>
            ) : (
              <span className="mono">{sha.slice(0, 7)}</span>
            ), v2: data.branch ? <>{tr('issues.issueHistory.on', { String: String(data.branch), t0: (c: ReactNode) => <span className="mono">{c}</span> })}</> : null })}</>
        ),
        body: (
          <ul className="change-lines">
            <li>{String(data.title ?? '')}</li>
            {command ? (
              <li className="same">
                #{command}
                {data.applied ? `: ${String(data.note ?? 'applied')}` : t('issues.issueHistory.notApplied', { v: String(data.note ?? '').replace(/^Not applied:\s*/i, '') || t('issues.issueHistory.seeTheCommit') })}
              </li>
            ) : null}
          </ul>
        ),
      };
    }
    case 'pull_request.linked':
    case 'pull_request.updated':
      return {
        ...base,
        did:
          e.type === 'pull_request.linked'
            ? t('issues.issueHistory.linkedPullRequest', { String: String(data.number ?? ''), String2: String(data.state ?? 'open') })
            : t('issues.issueHistory.sawPullRequest', { String: String(data.number ?? ''), v: data.state === 'merged' ? 'merged' : data.state === 'closed' ? 'closed' : 'reopened' }),
        body: (
          <ul className="change-lines">
            <li>{String(data.title ?? '')}</li>
          </ul>
        ),
      };
    case 'issue.moved':
      // Moved to another project (D41): the id it had, the one it has, and what its fields became.
      return {
        ...base,
        did: t('issues.issueHistory.movedItFromTo', { String: String(data.from ?? 'another project'), String2: String(data.to ?? t('issues.issueHistory.thisProject')) }),
        body: (
          <ul className="change-lines">
            {e.changes.map((c) => (
              <li key={c.field}>
                <span className="change-field">{c.field}:</span> {c.from !== null ? <del>{c.from}</del> : null} {c.to !== null ? <ins>{c.to}</ins> : null}
              </li>
            ))}
          </ul>
        ),
      };
    case 'link.created':
    case 'link.deleted': {
      const target = data.target as { id: string; summary: string } | undefined;
      const phrase = String(data.phrase ?? t('issues.issueHistory.linksTo'));
      return {
        ...base,
        did: undid(e, byId, 'link'),
        body: (
          <ul className="change-lines">
            <li>
              <span className="change-field">{e.type === 'link.created' ? t('issues.issueHistory.linked') : t('issues.issueHistory.unlinked')}</span>{' '}
              {e.type === 'link.created' ? <ins>{phrase}</ins> : <del>{phrase}</del>}{' '}
              {target ? (
                <Link to={`/issues/${target.id}`} className="issue-id">
                  {target.id}
                </Link>
              ) : null}
            </li>
          </ul>
        ),
      };
    }
    case 'work.logged':
      return {
        ...base,
        body: (
          <ul className="change-lines">
            <li>
              <span className="change-field">{t('issues.issueHistory.spentTime')}</span> <ins className="mono">{String(data.duration ?? '')}</ins> <span className="same">{t('issues.issueHistory.logged')}</span>
              {data.description ? <span className="same"> · {String(data.description)}</span> : null}
            </li>
          </ul>
        ),
      };
    case 'work.deleted':
      return { ...base, did: 'removed some logged work' };
    case 'attachment.added':
    case 'attachment.removed': {
      // A comment's files show under its words; only the issue's own are said here.
      if (typeof data.commentId === 'string') return null;
      const file = data.attachment as { id: string; name: string; size: number } | undefined;
      if (!file) return null;
      return {
        ...base,
        body: (
          <ul className="change-lines">
            <li>
              <span className="change-field">{e.type === 'attachment.added' ? t('issues.issueHistory.attached') : t('issues.issueHistory.removed')}</span>{' '}
              {e.type === 'attachment.added' ? <ins>{file.name}</ins> : <del>{file.name}</del>} <span className="same">{formatBytes(file.size)}</span>
            </li>
          </ul>
        ),
      };
    }
    case 'ai.triage.completed': {
      const n = Number(data.fields ?? 0);
      const dups = Number(data.duplicates ?? 0);
      const parts = [n ? t('issues.issueHistory.workedOutForAPerson', { n: n, v: n === 1 ? 'field' : 'fields' }) : t('issues.issueHistory.lookedAtItAndSuggested')];
      if (dups) parts.push(t('issues.issueHistory.foundPossible', { dups: dups, v: dups === 1 ? 'duplicate' : 'duplicates' }));
      return { ...base, did: parts.join(t('issues.issueHistory.and')) };
    }
    case 'rule.notified': {
      const people = Array.isArray(data.people) ? (data.people as unknown[]).map((p) => `@${String(p)}`) : [];
      const told = people.length <= 1 ? (people[0] ?? t('issues.issueHistory.nobody')) : t('issues.issueHistory.and2', { join: people.slice(0, -1).join(', '), v: people[people.length - 1] });
      return {
        ...base,
        did: t('issues.issueHistory.andTold', { v: byRule(data) ?? t('issues.issueHistory.appliedARule'), told: told }),
        body: (
          <ul className="change-lines">
            <li>“{String(data.message ?? '')}”</li>
          </ul>
        ),
      };
    }
    case 'rule.called':
      return { ...base, did: t('issues.issueHistory.andCalledItsWebhook', { v: byRule(data) ?? t('issues.issueHistory.appliedARule') }) };
    case 'sla.warning':
    case 'sla.breached': {
      // What time alone brought to a request's targets (D45), said by the help desk's agent.
      const target = data.target === 'resolution' ? 'resolution' : 'first-response';
      const policy = typeof data.policy === 'string' ? ` (${data.policy})` : '';
      const due = typeof data.dueAt === 'string' ? new Date(data.dueAt).toLocaleString(intlLocale()) : null;
      return {
        ...base,
        did: e.type === 'sla.warning' ? t('issues.issueHistory.saidItsTargetIsAt', { target: target, policy: policy, v: due ? t('issues.issueHistory.due', { due: due }) : '' }) : t('issues.issueHistory.saidItWentPastIts', { target: target, policy: policy, v: due ? t('issues.issueHistory.due2', { due: due }) : '' }),
      };
    }
    default:
      return null;
  }
}

function commentEntry(c: Comment, byEvent: Map<string, Actor>, files: Attachment[]): Entry {
  const actor: Actor = byEvent.get(c.id) ?? {
    id: c.author?.id ?? null,
    login: c.author?.login ?? null,
    name: c.author?.name ?? null,
    channel: c.channel,
    token: null,
    isBot: c.author?.isBot ?? false,
  };
  return {
    key: `c${c.id}`,
    at: c.createdAt,
    who: whoOf(actor, c.requester?.name),
    comment: c.text,
    public: c.visibility === 'public' ? (c.requester ? 'theirs' : 'reply') : undefined,
    limited: c.visibleTo ? audience(c.visibleTo) : undefined,
    files,
    anchor: `comment-${c.id}`,
    reactions: { id: c.id, list: c.reactions },
    source: c,
  };
}

function Head({ who, at, did, badge, action }: { who: Who; at: string; did?: React.ReactNode; badge?: React.ReactNode; action?: React.ReactNode }) {
  return (
    <p className="history-head">
      <strong className="who-name">{who.name}</strong>
      {who.forWhom ? t('issues.issueHistory.for', { forWhom: who.forWhom }) : ''}
      {did ? <> {did}</> : null}
      {who.via ? ` · ${who.via}` : ''} ·{' '}
      <time dateTime={at} title={new Date(at).toLocaleString(intlLocale())}>
        {when(at)}
      </time>
      {badge}
      {action}
    </p>
  );
}

/** Who sees a comment on a help desk request: the team alone, or the requester too, by email. */
function Visibility({ value, onChange, requester }: { value: CommentVisibility; onChange: (v: CommentVisibility) => void; requester: string }) {
  return (
    <div className="stack tight">
      <div className="modes" role="group" aria-label={t('issues.issueHistory.whoSeesThisComment')}>
        <button type="button" aria-pressed={value === 'internal'} onClick={() => onChange('internal')}>{t('issues.issueHistory.internalNote')}</button>
        <button type="button" aria-pressed={value === 'public'} onClick={() => onChange('public')}>{tr('issues.issueHistory.replyTo', { requester: requester })}</button>
      </div>
      <p className="field-help" id="visibility-help">
        {value === 'public' ? t('issues.issueHistory.getsItByEmailAnd', { requester: requester }) : t('issues.issueHistory.onlyTheTeamSeesIt', { requester: requester })}
      </p>
    </div>
  );
}

/**
 * Ocean's IssueHistory: what happened to an issue, in order, with its comments in their place; then
 * a comment of your own, when you may comment (a viewer may; an account that only reads may not).
 * Replying to a help desk's requester takes `canReply` (someone who may change the issue); `people`
 * are those a mention would reach. Someone who may change the issue (`canUndo`) can undo what an
 * agent changed on its own, while nobody has changed it since. A comment's checklist is ticked in place
 * by its author, or by a manager of the project (`canManage`): who may change the comment.
 */
export function IssueHistory({
  issue,
  me,
  canComment = true,
  canReply = true,
  canUndo = false,
  canManage = false,
  people,
}: {
  issue: IssueDetail;
  me: UserRef | undefined;
  canComment?: boolean;
  canReply?: boolean;
  canUndo?: boolean;
  canManage?: boolean;
  people?: User[];
}) {
  const qc = useQueryClient();
  const activity = useActivity(issue.id);
  const comments = useComments(issue.id);
  const files = useIssueAttachments(issue.id);
  const limits = useAttachmentLimits();
  const request = useRequestInfo(issue);
  const requester = request.data?.requester.name ?? null;
  const picker = useRef<HTMLInputElement>(null);
  const [text, setText] = useState('');
  const [visibility, setVisibility] = useState<CommentVisibility>('internal');
  const [limit, setLimit] = useState<Limit | null>(null);
  const [picked, setPicked] = useState<File[]>([]);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notAttached, setNotAttached] = useState<string[]>([]);
  const [undoing, setUndoing] = useState<number | null>(null);
  const [undoSaid, setUndoSaid] = useState<{ event: number; text: string; bad?: boolean } | null>(null);
  // A comment whose box was just ticked shows it ticked while it's saved; what went wrong, under it.
  const [ticked, setTicked] = useState<{ id: string; text: string } | null>(null);
  const [tickSaid, setTickSaid] = useState<{ id: string; text: string } | null>(null);

  if (activity.isLoading || comments.isLoading) return <Loading what={t('issues.issueHistory.theHistory')} />;
  if (activity.error) return <ErrorNote error={activity.error} />;
  if (comments.error) return <ErrorNote error={comments.error} />;

  // A comment's own event knows the agent or token that wrote it.
  const byEvent = new Map<string, Actor>();
  for (const e of activity.data ?? []) if (e.type === 'comment.created' && typeof e.data.commentId === 'string') byEvent.set(e.data.commentId, e.actor);
  const byComment = new Map<string, Attachment[]>();
  for (const f of files.data ?? []) if (f.comment) byComment.set(f.comment, [...(byComment.get(f.comment) ?? []), f]);
  const byId = new Map((activity.data ?? []).map((e) => [e.id, e]));
  const entries = [
    ...(activity.data ?? []).map((e) => eventEntry(e, byId)).filter((x): x is Entry => x !== null),
    ...(comments.data ?? []).map((c) => commentEntry(c, byEvent, byComment.get(c.id) ?? [])),
  ].sort((a, b) => a.at.localeCompare(b.at));

  // Undo an agent's change: as you, through the write path; it says what changed since, if anything did.
  const undo = async (entry: Entry) => {
    if (!entry.undo) return;
    const event = entry.undo.event;
    setUndoing(event);
    setUndoSaid(null);
    try {
      const done = await post<UndoResult>(`/events/${event}/undo`);
      const what = done.changes.map((c) => (c.field === 'Links' ? t('issues.issueHistory.theLink') : c.field));
      setUndoSaid({ event, text: t('issues.issueHistory.undoneAsBefore', { v: what.length ? what.join(', ') : t('issues.issueHistory.itsChange') }) });
      await Promise.all([qc.invalidateQueries({ queryKey: keys.issue(issue.id) }), qc.invalidateQueries({ queryKey: ['issues', 'list'] })]);
    } catch (e) {
      // What changed since, or who undid it already, in the server's words; anything else as usual.
      const said = e instanceof ApiError && (e.code === 'changed_since' || e.code === 'already_undone') ? e.message : errorText(e);
      setUndoSaid({ event, text: said, bad: true });
      await qc.invalidateQueries({ queryKey: keys.issueSub(issue.id, 'activity') });
    } finally {
      setUndoing(null);
    }
  };

  // Ticked against the version read: if the comment changed meanwhile, that's said and it's reloaded.
  const tick = async (c: Comment, index: number, checked: boolean) => {
    const next = toggleTask(c.text, index, checked);
    if (next === null) return;
    setTickSaid(null);
    setTicked({ id: c.id, text: next });
    try {
      await patch<Comment>(`/comments/${c.id}`, { text: next, expectedVersion: c.version });
    } catch (e) {
      setTickSaid({
        id: c.id,
        text: e instanceof ApiError && e.status === 409 ? t('issues.issueHistory.someoneChangedThisCommentJust') : errorText(e),
      });
    } finally {
      await qc.invalidateQueries({ queryKey: keys.issueSub(issue.id, 'comments') });
      setTicked(null);
    }
  };
  const mayTick = (c: Comment | undefined): c is Comment => Boolean(c && canComment && (canManage || (me && c.author?.id === me.id)));

  const used = (files.data ?? []).reduce((n, f) => n + f.size, 0);
  const fieldLabel = `${requester && canReply && visibility === 'public' ? t('issues.issueHistory.aReplyTo', { requester: requester }) : t('issues.issueHistory.aComment')}${me ? t('issues.issueHistory.as', { name: me.name }) : ''}`;
  const pick = (list: File[]) => setPicked((current) => [...current, ...list.filter((f) => !current.some((c) => c.name === f.name && c.size === f.size))]);

  const send = async () => {
    setError(null);
    setNotAttached([]);
    // Refuse what can't go before the comment is posted, so it isn't posted without its files.
    let ahead = used;
    for (const f of picked) {
      const no = refusal(f, limits.data, ahead);
      if (no) {
        setError(no);
        return;
      }
      ahead += f.size;
    }
    setBusy(true);
    setProgress(null);
    try {
      const isPublic = Boolean(requester && canReply && visibility === 'public');
      const comment = await post<Comment>(`/issues/${issue.id}/comments`, {
        text,
        ...(requester && canReply ? { visibility } : {}),
        ...(limit && !isPublic ? { visibleTo: limit } : {}),
      });
      setText('');
      setVisibility('internal');
      setLimit(null);
      const failed: string[] = [];
      for (const f of picked) {
        try {
          await uploadFile(`/comments/${comment.id}/attachments`, f, (sent, total) => setProgress(t('issues.issueHistory.attaching', { name: f.name, round: Math.round((sent / (total || 1)) * 100) })));
        } catch (e) {
          failed.push(t('issues.issueHistory.wasnTAttached', { name: f.name, errorText: errorText(e) }));
        }
      }
      setNotAttached(failed);
      setProgress(picked.length && !failed.length ? t('issues.issueHistory.commentedWith', { v: picked.length === 1 ? t('issues.issueHistory.itsFile') : t('issues.issueHistory.itsFiles', { length: picked.length }) }) : t('issues.issueHistory.commented'));
      setPicked([]);
      await Promise.all([
        qc.invalidateQueries({ queryKey: keys.issueSub(issue.id, 'comments') }),
        qc.invalidateQueries({ queryKey: keys.issueSub(issue.id, 'activity') }),
        qc.invalidateQueries({ queryKey: attachmentKeys.issue(issue.id) }),
        qc.invalidateQueries({ queryKey: ['issues', 'list'] }),
      ]);
    } catch (e) {
      setError(errorText(e));
      setProgress(null);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="stack" aria-labelledby="history-title">
      <h2 id="history-title">{t('issues.issueHistory.historyAndComments')}</h2>
      <ol className="history">
        {entries.map((e) => (
          <li key={e.key} id={e.anchor} className={e.undo?.state === 'undone' ? 'undone' : undefined}>
            <Avatar kind={e.who.kind} name={e.who.name} small />
            <div className="history-body">
              <Head
                who={e.who}
                at={e.at}
                did={e.did}
                badge={
                  e.public === 'reply' ? (
                    <Badge grammar="outside">{tr('issues.issueHistory.publicSentTo', { v: requester ?? t('issues.issueHistory.theRequester2') })}</Badge>
                  ) : e.public === 'theirs' ? (
                    <Badge grammar="outside">{t('issues.issueHistory.publicTheRequesterWroteIt')}</Badge>
                  ) : e.limited ? (
                    <Badge tone="idle" title={t('issues.issueHistory.itsAuthorTheProjectS')}>{tr('issues.issueHistory.visibleTo', { limited: e.limited })}</Badge>
                  ) : e.undo?.state === 'undone' ? (
                    <Badge tone="idle" title={e.undo.note}>{t('issues.issueHistory.undone')}</Badge>
                  ) : null
                }
                action={
                  canUndo && e.undo?.state === 'possible' ? (
                    <button
                      type="button"
                      className="history-undo"
                      aria-label={t('issues.issueHistory.undoSChange', { name: e.who.name })}
                      disabled={undoing !== null}
                      onClick={() => void undo(e)}
                    >
                      {undoing === e.undo.event ? t('issues.issueHistory.undoing') : t('issues.issueHistory.undo')}
                    </button>
                  ) : null
                }
              />
              {e.body}
              {undoSaid && e.undo?.event === undoSaid.event ? <Said text={undoSaid.text} tone={undoSaid.bad ? 'bad' : undefined} /> : null}
              {e.comment !== undefined ? (
                <div className={['history-comment', e.public ? 'public' : '', e.files?.length ? 'stack tight' : ''].filter(Boolean).join(' ')}>
                  <Markdown
                    text={ticked && ticked.id === e.source?.id ? ticked.text : e.comment}
                    onToggleTask={mayTick(e.source) && !ticked ? (i, on) => void tick(e.source!, i, on) : undefined}
                  />
                  {tickSaid && tickSaid.id === e.source?.id ? <ErrorLine>{tickSaid.text}</ErrorLine> : null}
                  {e.files?.length ? <CommentFiles files={e.files} /> : null}
                  {e.reactions ? <ReactionBar reactions={e.reactions.list} path={`/comments/${e.reactions.id}/reactions`} issue={issue.id} canReact={canComment} /> : null}
                </div>
              ) : null}
            </div>
          </li>
        ))}
      </ol>
      {canComment ? (
        <form
          className="form"
          onSubmit={(e) => {
            e.preventDefault();
            if (text.trim()) void send();
          }}
          onDragOver={(e) => {
            if (e.dataTransfer.types.includes('Files')) e.preventDefault();
          }}
          onDrop={(e) => {
            if (!e.dataTransfer.files.length) return;
            e.preventDefault();
            pick([...e.dataTransfer.files]);
          }}
        >
          {requester && canReply ? <Visibility value={visibility} onChange={setVisibility} requester={requester} /> : null}
          {limit && !(requester && canReply && visibility === 'public') ? (
            <LimitPicker value={limit} onChange={setLimit} always={t('issues.issueHistory.youSManagersAndAdministrators', { key: issue.project.key })} />
          ) : null}
          {requester && !canReply ? (
            <p className="field-help" id="visibility-help">{tr('issues.issueHistory.onlyTheTeamSeesYour', { requester: requester })}</p>
          ) : null}
          <FormField label={fieldLabel}>
            {(id) => (
              <RichField
                id={id}
                label={fieldLabel}
                value={text}
                onChange={setText}
                describedBy={requester ? 'visibility-help' : undefined}
                people={people}
                placeholder={t('issues.issueHistory.mentionSomeoneWithAndTheir')}
                uploadTo={`/issues/${issue.id}/attachments`}
                onUploaded={() => void qc.invalidateQueries({ queryKey: attachmentKeys.issue(issue.id) })}
                onOtherFiles={pick}
              />
            )}
          </FormField>
          {picked.length ? (
            <ul className="chips" aria-label={t('issues.issueHistory.filesToAttach')}>
              {picked.map((f) => (
                <li key={`${f.name}-${f.size}`} className="chip removable">
                  <span>
                    {f.name} · {formatBytes(f.size)}
                  </span>
                  <button type="button" className="chip-remove" aria-label={t('issues.issueHistory.leaveOut', { name: f.name })} onClick={() => setPicked((list) => list.filter((x) => x !== f))}>
                    <Icon name="cross" />
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
          {error ? <ErrorLine>{error}</ErrorLine> : null}
          {notAttached.map((m) => (
            <ErrorLine key={m}>{m}</ErrorLine>
          ))}
          <p role="status" className="outcome">
            {busy ? (progress ?? t('issues.issueHistory.commenting')) : (progress ?? '')}
          </p>
          <div className="cluster spread">
            <span className="cluster">
              <button type="button" onClick={() => picker.current?.click()} disabled={busy}>{tr('issues.issueHistory.attachFiles', { el: <Icon name="attach" /> })}</button>
              {requester && canReply && visibility === 'public' ? null : (
                <button type="button" aria-pressed={Boolean(limit)} onClick={() => setLimit(limit ? null : { users: [], groups: [] })} disabled={busy}>
                  {limit ? t('issues.issueHistory.letEveryoneSeeIt') : t('issues.issueHistory.limitWhoSeesIt')}
                </button>
              )}
            </span>
            <input
              ref={picker}
              type="file"
              multiple
              hidden
              onChange={(e) => {
                pick([...(e.target.files ?? [])]);
                e.target.value = '';
              }}
            />
            <button type="submit" className="primary" disabled={!text.trim() || busy}>
              {busy ? t('issues.issueHistory.sending') : requester ? (canReply && visibility === 'public' ? t('issues.issueHistory.sendTo', { requester: requester }) : t('issues.issueHistory.addTheInternalNote')) : t('issues.issueHistory.comment')}
            </button>
          </div>
        </form>
      ) : null}
    </section>
  );
}

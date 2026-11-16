import type { Attachment, Comment, CommentVisibility, IssueDetail, TrackerEvent, UndoResult, User, UserRef } from '@a4a/shared';
import { useQueryClient } from '@tanstack/react-query';
import { useRef, useState } from 'react';
import { Link } from 'react-router';
import { ApiError, post } from '../../api/client';
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
import { MentionField } from './MentionField';

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
  const person = actor.name ?? actor.login ?? 'someone';
  // An agent with a token of its own acts as itself, not for a person (D34).
  if (actor.isBot && (actor.channel === 'mcp' || actor.channel === 'api')) {
    return { kind: 'agent', name: actor.login ?? 'an agent', via: actor.channel === 'mcp' ? 'via MCP' : 'via the API' };
  }
  switch (actor.channel) {
    case 'helpdesk':
      return { kind: 'person', name: requester ?? 'The requester', via: 'via the help desk' };
    case 'web':
      return { kind: 'person', name: person, via: 'via the web' };
    case 'api':
      return { kind: 'service', name: actor.token ?? 'a script', forWhom: person, via: 'via the API' };
    case 'mcp':
      return { kind: 'agent', name: actor.token ?? 'an agent', forWhom: person, via: 'via MCP' };
    case 'assistant':
      return { kind: 'agent', name: 'assistant', forWhom: person, via: 'asked in words' };
    case 'automation':
      return { kind: 'agent', name: actor.login ?? 'automation', via: 'on its own' };
    case 'vcs':
      // A commit's author, known by a confirmed email or their login at the provider, or the integration itself.
      return actor.id
        ? { kind: 'person', name: person, via: `from ${actor.token ?? 'version control'}` }
        : { kind: 'service', name: actor.token ?? 'version control', via: 'from version control' };
    default:
      return { kind: 'own', name: 'a4a', via: '' };
  }
}

/** "applied the rule “Critical bugs go to Anna”", when a workflow rule made the change. */
function byRule(data: Record<string, unknown>): string | undefined {
  const name = (data.automation as { name?: unknown } | undefined)?.name;
  return typeof name === 'string' ? `applied the rule “${name}”` : undefined;
}

/** Today's time alone; older ones with their day, as people read them. */
export function when(iso: string, now = new Date()): string {
  const d = new Date(iso);
  const time = d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  if (d.toDateString() === now.toDateString()) return time;
  const sameYear = d.getFullYear() === now.getFullYear();
  const day = d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short', year: sameYear ? undefined : 'numeric' });
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
  /** A comment's own files, under its words; and its id, for links to it. */
  files?: Attachment[];
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
  return `undid ${original ? `${whoOf(original.actor).name}’s` : 'an agent’s'} ${what}`;
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
        const on = imported.createdAt ? `, where it was reported ${when(imported.createdAt)}${imported.reporter ? ` by ${imported.reporter}` : ''}` : '';
        return { ...base, did: `imported it from ${from} (${imported.key ?? 'its key there'})${on}` };
      }
      return { ...base, did: data.requester ? (data.via === 'email' ? 'asked for help by email' : 'asked for help') : 'reported it' };
    }
    case 'sprint.issue_added':
    case 'sprint.issue_removed':
      return { ...base, did: `${e.type === 'sprint.issue_added' ? 'put it in' : 'took it out of'} ${String(data.sprint ?? 'a sprint')}${data.board ? ` on ${String(data.board)}` : ''}` };
    case 'issue.updated':
      if (!e.changes.length) return null;
      return {
        ...base,
        did: undid(e, byId, 'change') ?? (data.acceptedFrom === 'triage' ? 'accepted what triage worked out' : byRule(data)),
        body: <ChangeLines changes={e.changes} />,
      };
    case 'commit.linked': {
      const sha = String(data.sha ?? '');
      const command = typeof data.command === 'string' ? data.command : null;
      return {
        ...base,
        did: (
          <>
            committed{' '}
            {typeof data.url === 'string' && /^https?:\/\//.test(data.url) ? (
              <a className="mono" href={data.url} rel="noreferrer noopener" target="_blank">
                {sha.slice(0, 7)}
              </a>
            ) : (
              <span className="mono">{sha.slice(0, 7)}</span>
            )}
            {data.branch ? <> on <span className="mono">{String(data.branch)}</span></> : null}
          </>
        ),
        body: (
          <ul className="change-lines">
            <li>{String(data.title ?? '')}</li>
            {command ? (
              <li className="same">
                #{command}
                {data.applied ? `: ${String(data.note ?? 'applied')}` : `, not applied: ${String(data.note ?? '').replace(/^Not applied:\s*/i, '') || 'see the commit'}`}
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
            ? `linked pull request #${String(data.number ?? '')} (${String(data.state ?? 'open')})`
            : `saw pull request #${String(data.number ?? '')} ${data.state === 'merged' ? 'merged' : data.state === 'closed' ? 'closed' : 'reopened'}`,
        body: (
          <ul className="change-lines">
            <li>{String(data.title ?? '')}</li>
          </ul>
        ),
      };
    case 'link.created':
    case 'link.deleted': {
      const target = data.target as { id: string; summary: string } | undefined;
      const phrase = String(data.phrase ?? 'links to');
      return {
        ...base,
        did: undid(e, byId, 'link'),
        body: (
          <ul className="change-lines">
            <li>
              <span className="change-field">{e.type === 'link.created' ? 'Linked:' : 'Unlinked:'}</span>{' '}
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
              <span className="change-field">Spent time:</span> <ins className="mono">{String(data.duration ?? '')}</ins> <span className="same">logged</span>
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
              <span className="change-field">{e.type === 'attachment.added' ? 'Attached:' : 'Removed:'}</span>{' '}
              {e.type === 'attachment.added' ? <ins>{file.name}</ins> : <del>{file.name}</del>} <span className="same">{formatBytes(file.size)}</span>
            </li>
          </ul>
        ),
      };
    }
    case 'ai.triage.completed': {
      const n = Number(data.fields ?? 0);
      const dups = Number(data.duplicates ?? 0);
      const parts = [n ? `worked out ${n} ${n === 1 ? 'field' : 'fields'}, for a person to accept` : 'looked at it and suggested nothing'];
      if (dups) parts.push(`found ${dups} possible ${dups === 1 ? 'duplicate' : 'duplicates'}`);
      return { ...base, did: parts.join(', and ') };
    }
    case 'rule.notified': {
      const people = Array.isArray(data.people) ? (data.people as unknown[]).map((p) => `@${String(p)}`) : [];
      const told = people.length <= 1 ? (people[0] ?? 'nobody') : `${people.slice(0, -1).join(', ')} and ${people[people.length - 1]}`;
      return {
        ...base,
        did: `${byRule(data) ?? 'applied a rule'}, and told ${told}`,
        body: (
          <ul className="change-lines">
            <li>“{String(data.message ?? '')}”</li>
          </ul>
        ),
      };
    }
    case 'rule.called':
      return { ...base, did: `${byRule(data) ?? 'applied a rule'}, and called its webhook` };
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
    files,
    anchor: `comment-${c.id}`,
    reactions: { id: c.id, list: c.reactions },
  };
}

function Head({ who, at, did, badge, action }: { who: Who; at: string; did?: React.ReactNode; badge?: React.ReactNode; action?: React.ReactNode }) {
  return (
    <p className="history-head">
      <strong className="who-name">{who.name}</strong>
      {who.forWhom ? ` for ${who.forWhom}` : ''}
      {did ? <> {did}</> : null}
      {who.via ? ` · ${who.via}` : ''} ·{' '}
      <time dateTime={at} title={new Date(at).toLocaleString()}>
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
      <div className="modes" role="group" aria-label="Who sees this comment">
        <button type="button" aria-pressed={value === 'internal'} onClick={() => onChange('internal')}>
          Internal note
        </button>
        <button type="button" aria-pressed={value === 'public'} onClick={() => onChange('public')}>
          Reply to {requester}
        </button>
      </div>
      <p className="field-help" id="visibility-help">
        {value === 'public' ? `${requester} gets it by email, and sees it on their request's page.` : `Only the team sees it. ${requester} doesn't.`}
      </p>
    </div>
  );
}

/**
 * Ocean's IssueHistory: what happened to an issue, in order, with its comments in their place; then
 * a comment of your own, when you may comment (a viewer may; an account that only reads may not).
 * Replying to a help desk's requester takes `canReply` (someone who may change the issue); `people`
 * are those a mention would reach. Someone who may change the issue (`canUndo`) can undo what an
 * agent changed on its own, while nobody has changed it since.
 */
export function IssueHistory({
  issue,
  me,
  canComment = true,
  canReply = true,
  canUndo = false,
  people,
}: {
  issue: IssueDetail;
  me: UserRef | undefined;
  canComment?: boolean;
  canReply?: boolean;
  canUndo?: boolean;
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
  const [picked, setPicked] = useState<File[]>([]);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notAttached, setNotAttached] = useState<string[]>([]);
  const [undoing, setUndoing] = useState<number | null>(null);
  const [undoSaid, setUndoSaid] = useState<{ event: number; text: string; bad?: boolean } | null>(null);

  if (activity.isLoading || comments.isLoading) return <Loading what="the history" />;
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
      const what = done.changes.map((c) => (c.field === 'Links' ? 'the link' : c.field));
      setUndoSaid({ event, text: `Undone: ${what.length ? what.join(', ') : 'its change'} as before.` });
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

  const used = (files.data ?? []).reduce((n, f) => n + f.size, 0);
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
      const comment = await post<Comment>(`/issues/${issue.id}/comments`, { text, ...(requester && canReply ? { visibility } : {}) });
      setText('');
      setVisibility('internal');
      const failed: string[] = [];
      for (const f of picked) {
        try {
          await uploadFile(`/comments/${comment.id}/attachments`, f, (sent, total) => setProgress(`Attaching ${f.name}: ${Math.round((sent / (total || 1)) * 100)}%`));
        } catch (e) {
          failed.push(`${f.name} wasn't attached: ${errorText(e)}`);
        }
      }
      setNotAttached(failed);
      setProgress(picked.length && !failed.length ? `Commented, with ${picked.length === 1 ? 'its file' : `its ${picked.length} files`}.` : 'Commented.');
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
      <h2 id="history-title">History and comments</h2>
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
                    <Badge grammar="outside">public: sent to {requester ?? 'the requester'}</Badge>
                  ) : e.public === 'theirs' ? (
                    <Badge grammar="outside">public: the requester wrote it</Badge>
                  ) : e.undo?.state === 'undone' ? (
                    <Badge tone="idle" title={e.undo.note}>
                      undone
                    </Badge>
                  ) : null
                }
                action={
                  canUndo && e.undo?.state === 'possible' ? (
                    <button
                      type="button"
                      className="history-undo"
                      aria-label={`Undo ${e.who.name}’s change`}
                      disabled={undoing !== null}
                      onClick={() => void undo(e)}
                    >
                      {undoing === e.undo.event ? 'Undoing…' : 'Undo'}
                    </button>
                  ) : null
                }
              />
              {e.body}
              {undoSaid && e.undo?.event === undoSaid.event ? <Said text={undoSaid.text} tone={undoSaid.bad ? 'bad' : undefined} /> : null}
              {e.comment !== undefined ? (
                <div className={['history-comment', e.public ? 'public' : '', e.files?.length ? 'stack tight' : ''].filter(Boolean).join(' ')}>
                  <Markdown text={e.comment} />
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
          {requester && !canReply ? (
            <p className="field-help" id="visibility-help">
              Only the team sees your comments here. Replying to {requester} is for the project&rsquo;s members.
            </p>
          ) : null}
          <FormField label={`${requester && canReply && visibility === 'public' ? `A reply to ${requester}` : 'A comment'}${me ? `, as ${me.name}` : ''}`}>
            {(id) => (
              <MentionField
                id={id}
                value={text}
                onChange={setText}
                describedBy={requester ? 'visibility-help' : undefined}
                people={people}
                placeholder="Markdown works here. Mention someone with @ and their login, and an issue or an article by its id, like BACK-12 or BACK-A-3."
              />
            )}
          </FormField>
          {picked.length ? (
            <ul className="chips" aria-label="Files to attach">
              {picked.map((f) => (
                <li key={`${f.name}-${f.size}`} className="chip removable">
                  <span>
                    {f.name} · {formatBytes(f.size)}
                  </span>
                  <button type="button" className="chip-remove" aria-label={`Leave out ${f.name}`} onClick={() => setPicked((list) => list.filter((x) => x !== f))}>
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
            {busy ? (progress ?? 'Commenting…') : (progress ?? '')}
          </p>
          <div className="cluster spread">
            <button type="button" onClick={() => picker.current?.click()} disabled={busy}>
              <Icon name="attach" />
              Attach files
            </button>
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
              {busy ? 'Sending…' : requester ? (canReply && visibility === 'public' ? `Send to ${requester}` : 'Add the internal note') : 'Comment'}
            </button>
          </div>
        </form>
      ) : null}
    </section>
  );
}

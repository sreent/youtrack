import type { Comment, CommentVisibility, IssueDetail, TrackerEvent, UserRef } from '@a4a/shared';
import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router';
import { post } from '../../api/client';
import { keys, useActivity, useComments } from '../../api/queries';
import { Badge } from '../../components/Badges';
import { ChangeLines } from '../../components/Changes';
import { Markdown } from '../../components/Markdown';
import { ErrorNote, Loading, ErrorLine } from '../../components/States';
import { Avatar, type WhoKind } from '../../components/Who';
import { errorText } from './api';
import { FormField } from '../../components/Form';
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
    default:
      return { kind: 'own', name: 'a4a', via: '' };
  }
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
}

function eventEntry(e: TrackerEvent): Entry | null {
  const data = e.data as Record<string, unknown>;
  const base = { key: `e${e.id}`, at: e.occurredAt, who: whoOf(e.actor, (data.requester as { name?: string } | undefined)?.name) };
  switch (e.type) {
    case 'issue.created':
      return { ...base, did: data.requester ? 'asked for help' : 'reported it' };
    case 'issue.updated':
      if (!e.changes.length) return null;
      return {
        ...base,
        did: data.acceptedFrom === 'triage' ? 'accepted what triage worked out' : undefined,
        body: <ChangeLines changes={e.changes} />,
      };
    case 'link.created':
    case 'link.deleted': {
      const target = data.target as { id: string; summary: string } | undefined;
      const phrase = String(data.phrase ?? 'links to');
      return {
        ...base,
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
    case 'ai.triage.completed': {
      const n = Number(data.fields ?? 0);
      const dups = Number(data.duplicates ?? 0);
      const parts = [n ? `worked out ${n} ${n === 1 ? 'field' : 'fields'}, for a person to accept` : 'looked at it and suggested nothing'];
      if (dups) parts.push(`found ${dups} possible ${dups === 1 ? 'duplicate' : 'duplicates'}`);
      return { ...base, did: parts.join(', and ') };
    }
    default:
      return null;
  }
}

function commentEntry(c: Comment, byEvent: Map<string, Actor>): Entry {
  const actor: Actor = byEvent.get(c.id) ?? {
    id: c.author?.id ?? null,
    login: c.author?.login ?? null,
    name: c.author?.name ?? null,
    channel: c.channel,
    token: null,
  };
  return {
    key: `c${c.id}`,
    at: c.createdAt,
    who: whoOf(actor, c.requester?.name),
    comment: c.text,
    public: c.visibility === 'public' ? (c.requester ? 'theirs' : 'reply') : undefined,
  };
}

function Head({ who, at, did, badge }: { who: Who; at: string; did?: React.ReactNode; badge?: React.ReactNode }) {
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

/** Ocean's IssueHistory: what happened to an issue, in order, with its comments in their place; then a comment of your own. */
export function IssueHistory({ issue, me }: { issue: IssueDetail; me: UserRef | undefined }) {
  const qc = useQueryClient();
  const activity = useActivity(issue.id);
  const comments = useComments(issue.id);
  const request = useRequestInfo(issue);
  const requester = request.data?.requester.name ?? null;
  const [text, setText] = useState('');
  const [visibility, setVisibility] = useState<CommentVisibility>('internal');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (activity.isLoading || comments.isLoading) return <Loading what="the history" />;
  if (activity.error) return <ErrorNote error={activity.error} />;
  if (comments.error) return <ErrorNote error={comments.error} />;

  // A comment's own event knows the agent or token that wrote it.
  const byEvent = new Map<string, Actor>();
  for (const e of activity.data ?? []) if (e.type === 'comment.created' && typeof e.data.commentId === 'string') byEvent.set(e.data.commentId, e.actor);
  const entries = [
    ...(activity.data ?? []).map(eventEntry).filter((x): x is Entry => x !== null),
    ...(comments.data ?? []).map((c) => commentEntry(c, byEvent)),
  ].sort((a, b) => a.at.localeCompare(b.at));

  const send = async () => {
    setBusy(true);
    setError(null);
    try {
      await post(`/issues/${issue.id}/comments`, { text, ...(requester ? { visibility } : {}) });
      setText('');
      setVisibility('internal');
      await Promise.all([
        qc.invalidateQueries({ queryKey: keys.issueSub(issue.id, 'comments') }),
        qc.invalidateQueries({ queryKey: keys.issueSub(issue.id, 'activity') }),
        qc.invalidateQueries({ queryKey: ['issues', 'list'] }),
      ]);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="stack" aria-labelledby="history-title">
      <h2 id="history-title">History and comments</h2>
      <ol className="history">
        {entries.map((e) => (
          <li key={e.key}>
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
                  ) : null
                }
              />
              {e.body}
              {e.comment !== undefined ? (
                <div className={e.public ? 'history-comment public' : 'history-comment'}>
                  <Markdown text={e.comment} />
                </div>
              ) : null}
            </div>
          </li>
        ))}
      </ol>
      <form
        className="form"
        onSubmit={(e) => {
          e.preventDefault();
          if (text.trim()) void send();
        }}
      >
        {requester ? <Visibility value={visibility} onChange={setVisibility} requester={requester} /> : null}
        <FormField label={`${requester && visibility === 'public' ? `A reply to ${requester}` : 'A comment'}${me ? `, as ${me.name}` : ''}`}>
          {(id) => (
            <MentionField
              id={id}
              value={text}
              onChange={setText}
              describedBy={requester ? 'visibility-help' : undefined}
              placeholder="Markdown works here. Mention someone with @ and their login, and an issue by its id, like BACK-12."
            />
          )}
        </FormField>
        {error ? (
          <ErrorLine>{error}</ErrorLine>
        ) : null}
        <div className="cluster end">
          <button type="submit" className="primary" disabled={!text.trim() || busy}>
            {busy ? 'Sending…' : requester ? (visibility === 'public' ? `Send to ${requester}` : 'Add the internal note') : 'Comment'}
          </button>
        </div>
      </form>
    </section>
  );
}

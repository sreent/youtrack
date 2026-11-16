import type { TrackerEvent } from '@a4a/shared';
import { Link } from 'react-router';
import { Badge, IssueLink } from '../../components/Badges';
import { actorWho, Who } from '../../components/Who';
import { ChangeLines } from '../common/ChangeLines';
import { dateRead, excerpt, utcSecond } from '../common/format';

type Grammar = 'reads' | 'writes' | 'changes' | 'outside' | 'own';

function str(v: unknown): string {
  return typeof v === 'string' ? v : typeof v === 'number' ? String(v) : '';
}

/** An article by its id, then its title; a deleted one isn't a link any more. */
function ArticleLink({ id, title, gone }: { id: string; title: string; gone?: boolean }) {
  return (
    <>
      {gone ? (
        <span className="issue-id">{id}</span>
      ) : (
        <Link className="issue-id" to={`/articles/${id}`}>
          {id}
        </Link>
      )}{' '}
      <span>{title}</span>
    </>
  );
}

function targetOf(e: TrackerEvent): { id: string; summary: string } | null {
  const t = e.data.target as { id?: string; summary?: string } | undefined;
  return t?.id ? { id: t.id, summary: t.summary ?? '' } : null;
}

/** The workflow rule that made a change, by its name. */
function ruleOf(e: TrackerEvent): string | null {
  const a = e.data.automation as { name?: string } | undefined;
  return typeof a?.name === 'string' ? a.name : null;
}

/** Through what, for whom, and where, in the ledger's words. */
function byLine(e: TrackerEvent): string {
  const name = e.actor.name ?? e.actor.login ?? 'someone';
  // An agent with a token of its own acts as itself (D34); its token is named, as a person's isn't.
  const itself = e.actor.isBot && (e.actor.channel === 'api' || e.actor.channel === 'mcp');
  const through: Record<TrackerEvent['actor']['channel'], string> = {
    web: 'through the web',
    email: 'by email',
    api: itself ? 'through the API, as itself' : `through the API, as ${name}`,
    mcp: itself ? 'over MCP, as itself' : `over MCP, for ${name}`,
    assistant: `through the assistant, for ${name}`,
    automation: 'on its own',
    system: "a4a's own",
    helpdesk: `through the help desk, for ${str((e.data.requester as { name?: string } | undefined)?.name) || 'a requester'}`,
    vcs: `from ${e.actor.token ?? 'version control'}`,
  };
  const tokenNamed = !itself && (e.actor.channel === 'api' || e.actor.channel === 'mcp' || e.actor.channel === 'vcs');
  return [through[e.actor.channel], ruleOf(e) ? `the rule “${ruleOf(e)}”` : null, tokenNamed ? null : e.actor.token ? `token ${e.actor.token}` : null, e.project]
    .filter(Boolean)
    .join(' · ');
}

/** What it did, in words, and a badge in the colour of what it did. */
function what(e: TrackerEvent): { text: React.ReactNode; badge: [Grammar, string] | null; more?: React.ReactNode } {
  const issue = e.issue ? (
    <>
      <IssueLink id={e.issue.id} /> <span>{e.issue.summary}</span>
    </>
  ) : null;
  const accepted = e.data.acceptedFrom === 'triage';
  switch (e.type) {
    case 'issue.created':
      if (e.data.imported) return { text: <>imported {issue}</>, badge: ['changes', 'imports an issue'] };
      return { text: <>created {issue}</>, badge: ['changes', 'new issue'] };
    case 'sprint.issue_added':
      return { text: <>put {issue} in {str(e.data.sprint)}</>, badge: ['changes', 'changes a sprint'] };
    case 'sprint.issue_removed':
      return { text: <>took {issue} out of {str(e.data.sprint)}</>, badge: ['changes', 'changes a sprint'] };
    case 'issue.updated':
      if (e.data.undoes !== undefined)
        return {
          text: <>undid an agent’s change to {issue}</>,
          badge: ['changes', 'undoes a change'],
          more: <ChangeLines changes={e.changes} />,
        };
      if (accepted)
        return {
          text: <>accepted what triage worked out for {issue}</>,
          badge: ['changes', e.changes.length === 1 ? `changes ${e.changes[0]!.field}` : `changes ${e.changes.length} fields`],
          more: <ChangeLines changes={e.changes} />,
        };
      return {
        text: <>changed {issue}</>,
        badge: ['changes', e.changes.length === 1 ? `changes ${e.changes[0]!.field}` : `changes ${e.changes.length} fields`],
        more: <ChangeLines changes={e.changes} />,
      };
    case 'issue.deleted':
      return { text: <>deleted {issue ?? 'an issue'}</>, badge: ['changes', 'deletes an issue'] };
    case 'comment.created':
      return {
        text: <>commented on {issue}</>,
        badge: ['changes', 'comments'],
        more: str(e.data.text) ? <q className="ledger-quote">{excerpt(str(e.data.text), 220)}</q> : null,
      };
    case 'comment.updated':
      return { text: <>edited a comment on {issue}</>, badge: ['changes', 'edits a comment'] };
    case 'comment.deleted':
      return { text: <>deleted a comment on {issue}</>, badge: ['changes', 'deletes a comment'] };
    case 'link.created':
    case 'link.deleted': {
      const t = targetOf(e);
      const linked = (
        <>
          {e.issue ? <IssueLink id={e.issue.id} /> : null} {str(e.data.phrase)} {t ? <IssueLink id={t.id} /> : null}
        </>
      );
      if (e.data.undoes !== undefined) {
        return e.type === 'link.created'
          ? { text: <>linked {linked} again, undoing an agent</>, badge: ['changes', 'undoes a change'] }
          : { text: <>unlinked {linked}, undoing an agent</>, badge: ['changes', 'undoes a change'] };
      }
      return e.type === 'link.created'
        ? { text: <>linked {linked}</>, badge: ['changes', 'links'] }
        : { text: <>unlinked {linked}</>, badge: ['changes', 'unlinks'] };
    }
    case 'work.logged':
      return {
        text: (
          <>
            logged <span className="mono">{str(e.data.duration)}</span> on {issue}
          </>
        ),
        badge: ['changes', 'logs work'],
        more:
          str(e.data.description) || str(e.data.date) ? (
            <span className="ledger-note">
              {[str(e.data.date) ? `for ${dateRead(str(e.data.date))}` : '', str(e.data.description)].filter(Boolean).join(': ')}
            </span>
          ) : null,
      };
    case 'work.deleted':
      return { text: <>removed logged work from {issue}</>, badge: ['changes', 'removes work'] };
    case 'ai.triage.completed':
      return {
        text: <>suggested changes to {issue}</>,
        badge: ['writes', 'suggests'],
        more: (
          <span className="ledger-note">
            {str(e.data.summary)} <Link to={e.project ? `/suggestions?project=${e.project}` : '/suggestions'}>Decide on it</Link>
          </span>
        ),
      };
    case 'attachment.added':
    case 'attachment.removed': {
      const file = e.data.attachment as { name?: string; size?: number } | undefined;
      const article = e.data.article as { id: string; title: string } | undefined;
      const on = article ? <ArticleLink id={article.id} title={article.title} /> : issue;
      return e.type === 'attachment.added'
        ? { text: <>attached <span className="mono">{str(file?.name)}</span> to {on}</>, badge: ['changes', 'attaches a file'] }
        : { text: <>removed <span className="mono">{str(file?.name)}</span> from {on}</>, badge: ['changes', 'removes a file'] };
    }
    case 'article.created':
    case 'article.updated':
    case 'article.deleted': {
      const article = e.data.article as { id: string; title: string } | undefined;
      const named = article ? <ArticleLink id={article.id} title={article.title} gone={e.type === 'article.deleted'} /> : 'an article';
      if (e.type === 'article.created') return { text: <>wrote {named}</>, badge: ['changes', 'writes an article'] };
      if (e.type === 'article.deleted') return { text: <>deleted {named}</>, badge: ['changes', 'deletes an article'] };
      return {
        text: e.data.moved && e.changes.every((c) => c.field === 'Parent' || c.field === 'Position') ? <>moved {named}</> : <>changed {named}</>,
        badge: ['changes', e.changes.some((c) => c.field === 'Content' || c.field === 'Title') ? 'saves a version' : 'moves an article'],
        more: <ChangeLines changes={e.changes} />,
      };
    }
    case 'commit.linked': {
      const command = str(e.data.command);
      return {
        text: (
          <>
            committed <span className="mono">{str(e.data.sha).slice(0, 7)}</span> to {issue}
          </>
        ),
        badge: ['outside', 'links a commit'],
        more: (
          <span className="ledger-note">
            {str(e.data.title)}
            {command ? (e.data.applied ? ` · #${command}: ${str(e.data.note) || 'applied'}` : ` · #${command}, not applied: ${str(e.data.note).replace(/^Not applied:\s*/i, '')}`) : ''}
          </span>
        ),
      };
    }
    case 'pull_request.linked':
    case 'pull_request.updated':
      return {
        text: (
          <>
            {e.type === 'pull_request.linked' ? 'linked pull request' : 'saw pull request'} <span className="mono">#{str(e.data.number)}</span> to {issue}
          </>
        ),
        badge: ['outside', e.type === 'pull_request.linked' ? 'links a pull request' : `pull request ${str(e.data.state)}`],
        more: <span className="ledger-note">{str(e.data.title)}</span>,
      };
    case 'baseline.created':
      return {
        text: (
          <>
            saved the baseline “{str(e.data.name)}” for {e.project ? <Link to={`/projects/${e.project}`}>{e.project}</Link> : 'a project'}
          </>
        ),
        badge: ['changes', 'saves a baseline'],
        more: (
          <span className="ledger-note">
            {[e.data.tasks !== undefined ? `${str(e.data.tasks)} tasks` : '', str(e.data.finish) ? `finishing ${dateRead(str(e.data.finish))}` : '']
              .filter(Boolean)
              .join(', ')}
          </span>
        ),
      };
    case 'project.member.added':
    case 'project.member.changed':
    case 'project.member.removed': {
      const project = e.project ? <Link to={`/projects/${e.project}`}>{e.project}</Link> : 'a project';
      const who = str(e.data.name) || str(e.data.user);
      if (e.type === 'project.member.added') return { text: <>made {who} a {str(e.data.role)} of {project}</>, badge: ['changes', 'gives a role'] };
      if (e.type === 'project.member.removed') return { text: <>took {who} out of {project}</>, badge: ['changes', 'takes a role away'] };
      return { text: <>made {who} a {str(e.data.to)} of {project}, not a {str(e.data.from)}</>, badge: ['changes', 'changes a role'] };
    }
    case 'project.group.added':
    case 'project.group.changed':
    case 'project.group.removed': {
      const project = e.project ? <Link to={`/projects/${e.project}`}>{e.project}</Link> : 'a project';
      const group = <>the group {str(e.data.name)}</>;
      if (e.type === 'project.group.added') return { text: <>made {group} a {str(e.data.role)} of {project}</>, badge: ['changes', 'gives a role'] };
      if (e.type === 'project.group.removed') return { text: <>took {group} out of {project}</>, badge: ['changes', 'takes a role away'] };
      return { text: <>made {group} a {str(e.data.to)} of {project}, not a {str(e.data.from)}</>, badge: ['changes', 'changes a role'] };
    }
    case 'project.visibility.changed':
      return {
        text: (
          <>
            made {e.project ? <Link to={`/projects/${e.project}`}>{e.project}</Link> : 'a project'}{' '}
            {str(e.data.to) === 'members' ? 'visible to its members only' : 'open to everyone'}
          </>
        ),
        badge: ['changes', 'changes who sees it'],
      };
    case 'rule.notified': {
      const people = Array.isArray(e.data.people) ? (e.data.people as unknown[]).map(String) : [];
      return {
        text: (
          <>
            told {people.map((p) => `@${p}`).join(', ') || 'nobody'} of {issue}
          </>
        ),
        badge: ['own', 'tells people'],
        more: <span className="ledger-note">“{str(e.data.message)}”</span>,
      };
    }
    case 'rule.called':
      return { text: <>called a webhook about {issue}</>, badge: ['outside', 'calls out'] };
    default:
      return {
        text: (
          <>
            {String(e.type)} {issue}
          </>
        ),
        badge: null,
      };
  }
}

/**
 * A line of Ocean's ledger (AuditEntry): when, to the second in UTC; who, by their mark; what it
 * did, in the colour of what it did; and through what, for whom and where.
 */
export function LedgerEntry({ event }: { event: TrackerEvent }) {
  const who = actorWho(event.actor, event.data);
  const w = what(event);
  return (
    <li>
      <time dateTime={event.occurredAt}>{utcSecond(event.occurredAt)}</time>
      <div className="ledger-body">
        <div className="ledger-what">
          <Who kind={who.kind} name={who.name} />
          <span className="ledger-did">{w.text}</span>
          {w.badge ? <Badge grammar={w.badge[0]}>{w.badge[1]}</Badge> : null}
        </div>
        {w.more ? <div className="ledger-more">{w.more}</div> : null}
        <div className="ledger-by">
          {byLine(event)} · <span className="mono">event {event.id}</span>
        </div>
      </div>
    </li>
  );
}

/** A link is recorded on both its issues; the ledger shows it once, as the person made it. */
export function withoutMirrors(events: TrackerEvent[]): TrackerEvent[] {
  const out: TrackerEvent[] = [];
  for (let i = 0; i < events.length; i++) {
    const e = events[i]!;
    const n = events[i + 1];
    if ((e.type === 'link.created' || e.type === 'link.deleted') && n && n.type === e.type && n.occurredAt === e.occurredAt && n.actor.id === e.actor.id) {
      const a = targetOf(e);
      const b = targetOf(n);
      if (a && b && e.issue && n.issue && a.id === n.issue.id && b.id === e.issue.id) {
        // Newest first: the later row is the far side; keep the one recorded first.
        out.push(e.id < n.id ? e : n);
        i++;
        continue;
      }
    }
    out.push(e);
  }
  return out;
}

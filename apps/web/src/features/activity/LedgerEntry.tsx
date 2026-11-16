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

function targetOf(e: TrackerEvent): { id: string; summary: string } | null {
  const t = e.data.target as { id?: string; summary?: string } | undefined;
  return t?.id ? { id: t.id, summary: t.summary ?? '' } : null;
}

/** Through what, for whom, and where, in the ledger's words. */
function byLine(e: TrackerEvent): string {
  const name = e.actor.name ?? e.actor.login ?? 'someone';
  const through: Record<TrackerEvent['actor']['channel'], string> = {
    web: 'through the web',
    api: `through the API, as ${name}`,
    mcp: `over MCP, for ${name}`,
    assistant: `through the assistant, for ${name}`,
    automation: 'on its own',
    system: "a4a's own",
  };
  return [through[e.actor.channel], e.actor.channel === 'api' || e.actor.channel === 'mcp' ? null : e.actor.token ? `token ${e.actor.token}` : null, e.project]
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
      return { text: <>created {issue}</>, badge: ['changes', 'new issue'] };
    case 'issue.updated':
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
  const who = actorWho(event.actor);
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

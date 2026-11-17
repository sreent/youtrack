import type { TrackerEvent } from '@a4a/shared';
import { Link } from 'react-router';
import { Badge, IssueLink } from '../../components/Badges';
import { actorWho, Who } from '../../components/Who';
import { ChangeLines } from '../common/ChangeLines';
import { dateRead, excerpt, utcSecond } from '../common/format';
import { aRole } from '../roles/words';
import { commandNote, t, t as tx, tr } from '../../i18n';
import type { ReactNode } from 'react';

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
  const name = e.actor.name ?? e.actor.login ?? t('activity.ledgerEntry.someone');
  // An agent with a token of its own acts as itself (D34); its token is named, as a person's isn't.
  const itself = e.actor.isBot && (e.actor.channel === 'api' || e.actor.channel === 'mcp');
  const through: Record<TrackerEvent['actor']['channel'], string> = {
    web: t('activity.ledgerEntry.throughTheWeb'),
    email: t('activity.ledgerEntry.byEmail'),
    api: itself ? t('activity.ledgerEntry.throughTheApiAsItself') : t('activity.ledgerEntry.throughTheApiAs', { name: name }),
    mcp: itself ? t('activity.ledgerEntry.overMcpAsItself') : t('activity.ledgerEntry.overMcpFor', { name: name }),
    assistant: t('activity.ledgerEntry.throughTheAssistantFor', { name: name }),
    automation: t('activity.ledgerEntry.onItsOwn'),
    system: t('activity.ledgerEntry.a4aSOwn'),
    helpdesk: t('activity.ledgerEntry.throughTheHelpDeskFor', { v: str((e.data.requester as { name?: string } | undefined)?.name) || t('activity.ledgerEntry.aRequester') }),
    vcs: e.actor.token ? t('activity.ledgerEntry.from', { v: e.actor.token }) : t('activity.ledgerEntry.fromVersionControl'),
    chat: e.actor.token ? t('activity.ledgerEntry.fromAs', { v: e.actor.token, name: name }) : t('activity.ledgerEntry.fromChatAs', { name: name }),
    ci: t('activity.ledgerEntry.fromABuildOf', { v: e.actor.token ?? 'CI' }),
    // An app's agent on its own (its rules), or a person through an app's widget or handler (D48).
    app: e.actor.isBot
      ? e.actor.token
        ? t('activity.ledgerEntry.asAppNamed', { app: e.actor.token })
        : t('activity.ledgerEntry.asAnApp')
      : e.actor.token
        ? t('activity.ledgerEntry.throughAppNamedFor', { app: e.actor.token, name: name })
        : t('activity.ledgerEntry.throughAnAppFor', { name: name }),
  };
  const tokenNamed = !itself && (e.actor.channel === 'api' || e.actor.channel === 'mcp' || e.actor.channel === 'vcs' || e.actor.channel === 'chat' || e.actor.channel === 'ci');
  return [through[e.actor.channel], ruleOf(e) ? t('activity.ledgerEntry.theRule', { ruleOf: ruleOf(e) }) : null, tokenNamed ? null : e.actor.token ? t('activity.ledgerEntry.token', { token: e.actor.token }) : null, e.project]
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
      if (e.data.imported) return { text: <>{tr('activity.ledgerEntry.imported', { issue: issue })}</>, badge: ['changes', t('activity.ledgerEntry.importsAnIssue')] };
      return { text: <>{tr('activity.ledgerEntry.created', { issue: issue })}</>, badge: ['changes', tx('activity.ledgerEntry.badgeNewIssue')] };
    case 'sprint.issue_added':
      return { text: <>{tr('activity.ledgerEntry.putIn', { issue: issue, str: str(e.data.sprint) })}</>, badge: ['changes', t('activity.ledgerEntry.changesASprint')] };
    case 'sprint.issue_removed':
      return { text: <>{tr('activity.ledgerEntry.tookOutOf', { issue: issue, str: str(e.data.sprint) })}</>, badge: ['changes', t('activity.ledgerEntry.changesASprint')] };
    case 'board.issue_ranked':
      return { text: <>{tr('activity.ledgerEntry.rankedOn', { issue: issue, str: str(e.data.board) })}</>, badge: ['changes', t('activity.ledgerEntry.changesABoardSOrder')] };
    case 'issue.updated':
      if (e.data.undoes !== undefined)
        return {
          text: <>{tr('activity.ledgerEntry.undidAnAgentSChange', { issue: issue })}</>,
          badge: ['changes', t('activity.ledgerEntry.undoesAChange')],
          more: <ChangeLines changes={e.changes} />,
        };
      if (accepted)
        return {
          text: <>{tr('activity.ledgerEntry.acceptedWhatTriageWorkedOut', { issue: issue })}</>,
          badge: ['changes', e.changes.length === 1 ? t('activity.ledgerEntry.changes', { field: e.changes[0]!.field }) : t('activity.ledgerEntry.changesFields', { length: e.changes.length })],
          more: <ChangeLines changes={e.changes} />,
        };
      return {
        text: <>{tr('activity.ledgerEntry.changed', { issue: issue })}</>,
        badge: ['changes', e.changes.length === 1 ? t('activity.ledgerEntry.changes', { field: e.changes[0]!.field }) : t('activity.ledgerEntry.changesFields', { length: e.changes.length })],
        more: <ChangeLines changes={e.changes} />,
      };
    case 'issue.deleted':
      return { text: <>{tr('activity.ledgerEntry.deleted', { v: issue ?? t('activity.ledgerEntry.anIssue') })}</>, badge: ['changes', t('activity.ledgerEntry.deletesAnIssue')] };
    case 'comment.created':
      return {
        text: <>{tr('activity.ledgerEntry.commentedOn', { issue: issue })}</>,
        badge: ['changes', tx('activity.ledgerEntry.badgeComments')],
        more: str(e.data.text) ? <q className="ledger-quote">{excerpt(str(e.data.text), 220)}</q> : null,
      };
    case 'comment.updated':
      return { text: <>{tr('activity.ledgerEntry.editedACommentOn', { issue: issue })}</>, badge: ['changes', t('activity.ledgerEntry.editsAComment')] };
    case 'comment.deleted':
      return { text: <>{tr('activity.ledgerEntry.deletedACommentOn', { issue: issue })}</>, badge: ['changes', t('activity.ledgerEntry.deletesAComment')] };
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
          ? { text: <>{tr('activity.ledgerEntry.linkedAgainUndoingAnAgent', { linked: linked })}</>, badge: ['changes', tx('activity.ledgerEntry.undoesAChange')] }
          : { text: <>{tr('activity.ledgerEntry.unlinkedUndoingAnAgent', { linked: linked })}</>, badge: ['changes', tx('activity.ledgerEntry.undoesAChange')] };
      }
      return e.type === 'link.created'
        ? { text: <>{tr('activity.ledgerEntry.linked', { linked: linked })}</>, badge: ['changes', tx('activity.ledgerEntry.badgeLinks')] }
        : { text: <>{tr('activity.ledgerEntry.unlinked', { linked: linked })}</>, badge: ['changes', tx('activity.ledgerEntry.badgeUnlinks')] };
    }
    case 'work.logged':
      return {
        text: (
          <>{tr('activity.ledgerEntry.loggedOn', { str: str(e.data.duration), t0: (c: ReactNode) => <span className="mono">{c}</span>, issue: issue })}</>
        ),
        badge: ['changes', tx('activity.ledgerEntry.badgeLogsWork')],
        more:
          str(e.data.description) || str(e.data.date) ? (
            <span className="ledger-note">
              {[str(e.data.date) ? t('activity.ledgerEntry.for', { dateRead: dateRead(str(e.data.date)) }) : '', str(e.data.description)].filter(Boolean).join(': ')}
            </span>
          ) : null,
      };
    case 'work.deleted':
      return { text: <>{tr('activity.ledgerEntry.removedLoggedWorkFrom', { issue: issue })}</>, badge: ['changes', tx('activity.ledgerEntry.badgeRemovesWork')] };
    case 'ai.triage.completed':
      return {
        text: <>{tr('activity.ledgerEntry.suggestedChangesTo', { issue: issue })}</>,
        badge: ['writes', tx('activity.ledgerEntry.badgeSuggests')],
        more: (
          <span className="ledger-note">
            {str(e.data.summary)} <Link to={e.project ? `/suggestions?project=${e.project}` : '/suggestions'}>{t('activity.ledgerEntry.decideOnIt')}</Link>
          </span>
        ),
      };
    case 'attachment.added':
    case 'attachment.removed': {
      const file = e.data.attachment as { name?: string; size?: number } | undefined;
      const article = e.data.article as { id: string; title: string } | undefined;
      const on = article ? <ArticleLink id={article.id} title={article.title} /> : issue;
      return e.type === 'attachment.added'
        ? { text: <>{tr('activity.ledgerEntry.attachedTo', { str: str(file?.name), t0: (c: ReactNode) => <span className="mono">{c}</span>, on: on })}</>, badge: ['changes', t('activity.ledgerEntry.attachesAFile')] }
        : { text: <>{tr('activity.ledgerEntry.removedFrom', { str: str(file?.name), t0: (c: ReactNode) => <span className="mono">{c}</span>, on: on })}</>, badge: ['changes', t('activity.ledgerEntry.removesAFile')] };
    }
    case 'article.created':
    case 'article.updated':
    case 'article.deleted': {
      const article = e.data.article as { id: string; title: string } | undefined;
      const named = article ? <ArticleLink id={article.id} title={article.title} gone={e.type === 'article.deleted'} /> : t('activity.ledgerEntry.anArticle');
      if (e.type === 'article.created') return { text: <>{tr('activity.ledgerEntry.wrote', { named: named })}</>, badge: ['changes', t('activity.ledgerEntry.writesAnArticle')] };
      if (e.type === 'article.deleted') return { text: <>{tr('activity.ledgerEntry.deleted2', { named: named })}</>, badge: ['changes', t('activity.ledgerEntry.deletesAnArticle')] };
      return {
        text: e.data.moved && e.changes.every((c) => c.field === 'Parent' || c.field === 'Position') ? <>{tr('activity.ledgerEntry.moved', { named: named })}</> : <>{tr('activity.ledgerEntry.changed2', { named: named })}</>,
        badge: [
          'changes',
          e.changes.some((c) => c.field === 'Content' || c.field === 'Title')
            ? t('activity.ledgerEntry.savesAVersion')
            : e.changes.some((c) => c.field === 'Visible to')
              ? t('activity.ledgerEntry.changesWhoSeesAnArticle')
              : t('activity.ledgerEntry.movesAnArticle'),
        ],
        more: <ChangeLines changes={e.changes} />,
      };
    }
    case 'commit.linked': {
      const command = str(e.data.command);
      return {
        text: (
          <>{tr('activity.ledgerEntry.committedTo', { slice: str(e.data.sha).slice(0, 7), t0: (c: ReactNode) => <span className="mono">{c}</span>, issue: issue })}</>
        ),
        badge: ['outside', t('activity.ledgerEntry.linksACommit')],
        more: (
          <span className="ledger-note">
            {str(e.data.title)}
            {command ? (e.data.applied ? (str(e.data.note) ? t('activity.ledgerEntry.commandNote', { command: command, note: commandNote(e.data.said, e.data.note) }) : t('activity.ledgerEntry.commandApplied', { command: command })) : t('activity.ledgerEntry.notApplied', { command: command, replace: commandNote(e.data.said, e.data.note) })) : ''}
          </span>
        ),
      };
    }
    case 'pull_request.linked':
    case 'pull_request.updated':
      return {
        text: (
          <>{tr(e.type === 'pull_request.linked' ? 'activity.ledgerEntry.linkedPullRequestTo' : 'activity.ledgerEntry.sawPullRequestFor', { str: str(e.data.number), t0: (c: ReactNode) => <span className="mono">{c}</span>, issue: issue })}</>
        ),
        badge: ['outside', e.type === 'pull_request.linked' ? t('activity.ledgerEntry.linksAPullRequest') : t('activity.ledgerEntry.pullRequestState', { state: str(e.data.state) /* a stable code the message selects on */ })],
        more: <span className="ledger-note">{str(e.data.title)}</span>,
      };
    case 'baseline.created':
      return {
        text: (
          <>{tr('activity.ledgerEntry.savedTheBaselineFor', { str: str(e.data.name), v: e.project ? <Link to={`/projects/${e.project}`}>{e.project}</Link> : t('activity.ledgerEntry.aProject') })}</>
        ),
        badge: ['changes', t('activity.ledgerEntry.savesABaseline')],
        more: (
          <span className="ledger-note">
            {[e.data.tasks !== undefined ? t('activity.ledgerEntry.taskCount', { n: Number(e.data.tasks) }) : '', str(e.data.finish) ? t('activity.ledgerEntry.finishing', { dateRead: dateRead(str(e.data.finish)) }) : '']
              .filter(Boolean)
              .join(', ')}
          </span>
        ),
      };
    case 'project.member.added':
    case 'project.member.changed':
    case 'project.member.removed': {
      const project = e.project ? <Link to={`/projects/${e.project}`}>{e.project}</Link> : t('activity.ledgerEntry.aProject');
      const who = str(e.data.name) || str(e.data.user);
      if (e.type === 'project.member.added') return { text: <>{tr('activity.ledgerEntry.madeRoleOf', { who: who, role: aRole(str(e.data.role), str(e.data.role)), project: project })}</>, badge: ['changes', t('activity.ledgerEntry.givesARole')] };
      if (e.type === 'project.member.removed') return { text: <>{tr('activity.ledgerEntry.tookOutOf2', { who: who, project: project })}</>, badge: ['changes', t('activity.ledgerEntry.takesARoleAway')] };
      return { text: <>{tr('activity.ledgerEntry.madeRoleOfNot', { who: who, role: aRole(str(e.data.to), str(e.data.to)), project: project, before: aRole(str(e.data.from), str(e.data.from)) })}</>, badge: ['changes', t('activity.ledgerEntry.changesARole')] };
    }
    case 'project.group.added':
    case 'project.group.changed':
    case 'project.group.removed': {
      const project = e.project ? <Link to={`/projects/${e.project}`}>{e.project}</Link> : t('activity.ledgerEntry.aProject');
      const group = <>{tr('activity.ledgerEntry.theGroup', { str: str(e.data.name) })}</>;
      if (e.type === 'project.group.added') return { text: <>{tr('activity.ledgerEntry.madeRoleOf2', { group: group, role: aRole(str(e.data.role), str(e.data.role)), project: project })}</>, badge: ['changes', t('activity.ledgerEntry.givesARole')] };
      if (e.type === 'project.group.removed') return { text: <>{tr('activity.ledgerEntry.tookOutOf3', { group: group, project: project })}</>, badge: ['changes', t('activity.ledgerEntry.takesARoleAway')] };
      return { text: <>{tr('activity.ledgerEntry.madeRoleOfNot2', { group: group, role: aRole(str(e.data.to), str(e.data.to)), project: project, before: aRole(str(e.data.from), str(e.data.from)) })}</>, badge: ['changes', t('activity.ledgerEntry.changesARole')] };
    }
    case 'project.key.changed':
      return {
        text: <>{tr('activity.ledgerEntry.renamedKey', { from: str(e.data.from), to: <Link to={`/projects/${e.project ?? str(e.data.to)}`}>{str(e.data.to)}</Link> })}</>,
        badge: ['changes', t('activity.ledgerEntry.renamesAKey')],
      };
    case 'project.visibility.changed':
      return {
        text: (
          <>{tr('activity.ledgerEntry.made', { v: e.project ? <Link to={`/projects/${e.project}`}>{e.project}</Link> : t('activity.ledgerEntry.aProject'), v2: str(e.data.to) === 'members' ? t('activity.ledgerEntry.visibleToItsMembersOnly') : t('activity.ledgerEntry.openToEveryone') })}</>
        ),
        badge: ['changes', t('activity.ledgerEntry.changesWhoSeesIt')],
      };
    case 'rule.notified': {
      const people = Array.isArray(e.data.people) ? (e.data.people as unknown[]).map(String) : [];
      return {
        text: (
          <>{tr('activity.ledgerEntry.toldOf', { v: people.map((p) => `@${p}`).join(', ') || t('activity.ledgerEntry.nobody'), issue: issue })}</>
        ),
        badge: ['own', tx('activity.ledgerEntry.badgeTellsPeople')],
        more: <span className="ledger-note">“{str(e.data.message)}”</span>,
      };
    }
    case 'rule.called':
      return { text: <>{tr('activity.ledgerEntry.calledAWebhookAbout', { issue: issue })}</>, badge: ['outside', tx('activity.ledgerEntry.badgeCallsOut')] };
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
          {byLine(event)} · <span className="mono">{tr('activity.ledgerEntry.event', { id: event.id })}</span>
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

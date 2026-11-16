import type { IssueDetail, Sla } from '@a4a/shared';
import { Badge } from '../../components/Badges';
import { Who } from '../../components/Who';
import { useRequestInfo } from '../notifications/api';
import { RequestSla } from './Sla';

/** A length of time as people say it: "40 minutes", "3 hours", "2 days". */
export function span(ms: number): string {
  const minutes = Math.max(1, Math.round(Math.abs(ms) / 60_000));
  if (minutes < 60) return `${minutes} ${minutes === 1 ? 'minute' : 'minutes'}`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} ${hours === 1 ? 'hour' : 'hours'}`;
  const days = Math.round(hours / 24);
  return `${days} days`;
}

/**
 * A request against its first-response target: waiting, with a clock (warn), until it's due; past it,
 * a cross (bad); answered in time, a tick (good); answered late, a plain fact. No target, nothing.
 */
export function SlaBadge({ sla, since, now = Date.now() }: { sla: Sla; since: string; now?: number }) {
  if (sla.state === 'none' || !sla.dueAt) return null;
  const due = new Date(sla.dueAt).getTime();
  const answered = sla.respondedAt ? new Date(sla.respondedAt).getTime() : null;
  switch (sla.state) {
    case 'due':
      return <Badge tone="warn" title={`First response due ${new Date(due).toLocaleString()}`}>first response due in {span(due - now)}</Badge>;
    case 'overdue':
      return <Badge tone="bad" title={`First response was due ${new Date(due).toLocaleString()}`}>first response {span(now - due)} overdue</Badge>;
    case 'met':
      return <Badge tone="good">{answered ? `answered in ${span(answered - new Date(since).getTime())}` : 'resolved within its target'}</Badge>;
    case 'missed':
      return <Badge>{answered ? `answered ${span(answered - due)} late` : 'resolved after its target'}</Badge>;
    default:
      return null;
  }
}

/** Who asked, through the help desk, and where it stands against its first-response target. */
export function RequestCard({ issue }: { issue: IssueDetail }) {
  const info = useRequestInfo(issue);
  const r = info.data;
  if (!r) return null;
  return (
    <section className="card side-card stack tight" aria-labelledby="request-title">
      <h2 id="request-title">Help desk request</h2>
      <Who kind="person" name={r.requester.name} about={r.requester.email} small />
      {r.sla.clocks.length ? <RequestSla issueId={issue.id} r={r} canReply /> : <SlaBadge sla={r.firstResponse} since={r.createdAt} />}
      <p className="note">
        {r.via === 'email' ? 'They wrote in by email, and may answer by email. ' : ''}
        {r.emailMuted
          ? 'They stopped emails about it. Public replies still show on their page.'
          : 'Public replies and changes of state reach them by email, and on their page. Internal notes never do.'}
      </p>
    </section>
  );
}

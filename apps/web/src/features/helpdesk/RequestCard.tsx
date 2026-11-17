import type { CustomerGroup, HelpdeskRequest, IssueDetail, Sla } from '@a4a/shared';
import { Badge } from '../../components/Badges';
import { Who } from '../../components/Who';
import { inboxKeys, useRequestInfo } from '../notifications/api';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { get, patch } from '../../api/client';
import { errorText, FormField, Said } from '../common/bits';
import { RequestSla } from './Sla';
import { intlLocale, t, tr } from '../../i18n';

/** A length of time as people say it: "40 minutes", "3 hours", "2 days". */
export function span(ms: number): string {
  const minutes = Math.max(1, Math.round(Math.abs(ms) / 60_000));
  if (minutes < 60) return t('count.minutes', { n: minutes });
  const hours = Math.round(minutes / 60);
  if (hours < 48) return t('count.hours', { n: hours });
  return t('count.days', { n: Math.round(hours / 24) });
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
      return <Badge tone="warn" title={t('helpdesk.requestCard.firstResponseDue', { toLocaleString: new Date(due).toLocaleString(intlLocale()) })}>{tr('helpdesk.requestCard.firstResponseDueIn', { span: span(due - now) })}</Badge>;
    case 'overdue':
      return <Badge tone="bad" title={t('helpdesk.requestCard.firstResponseWasDue', { toLocaleString: new Date(due).toLocaleString(intlLocale()) })}>{tr('helpdesk.requestCard.firstResponseOverdue', { span: span(now - due) })}</Badge>;
    case 'met':
      return <Badge tone="good">{answered ? t('helpdesk.requestCard.answeredIn', { span: span(answered - new Date(since).getTime()) }) : t('helpdesk.requestCard.resolvedWithinItsTarget')}</Badge>;
    case 'missed':
      return <Badge>{answered ? t('helpdesk.requestCard.answeredLate', { span: span(answered - due) }) : t('helpdesk.requestCard.resolvedAfterItsTarget')}</Badge>;
    default:
      return null;
  }
}

/**
 * Its customer group (D56): which, what its members see of it, and for whoever may change the
 * request, another group or none, and keeping it from the group. Each a change in its history.
 */
function RequestGroup({ issue, r, canEdit }: { issue: IssueDetail; r: HelpdeskRequest; canEdit: boolean }) {
  const qc = useQueryClient();
  const groups = useQuery({ queryKey: ['customer-groups', issue.project.key], queryFn: () => get<CustomerGroup[]>(`/projects/${issue.project.key}/customer-groups`), staleTime: 30_000 });
  const [said, setSaid] = useState<{ text: string; bad?: boolean } | null>(null);
  const change = useMutation({
    mutationFn: (body: { group?: string | null; private?: boolean }) => patch<HelpdeskRequest>(`/issues/${issue.id}/request`, body),
    onSuccess: (next) => {
      qc.setQueryData(inboxKeys.request(issue.id), next);
      void qc.invalidateQueries({ queryKey: ['issues', 'one', issue.id] });
      setSaid({ text: t('helpdesk.sla.saved') });
    },
    onError: (e) => setSaid({ text: errorText(e), bad: true }),
  });
  if (!r.group && !groups.data?.length) return null;
  // What was chosen shows at once, while it saves.
  const asked = change.isPending ? change.variables : undefined;
  const groupShown = asked?.group !== undefined ? (asked.group ?? '') : (r.group?.id ?? '');
  const privateShown = asked?.private !== undefined ? asked.private : r.private;
  return (
    <div className="stack tight">
      {canEdit && groups.data?.length ? (
        <FormField label={t('helpdesk.requestCard.customerGroup')}>
          {(id) => (
            <select id={id} value={groupShown} disabled={change.isPending} onChange={(e) => change.mutate({ group: e.target.value || null })}>
              <option value="">{t('helpdesk.requestCard.noGroup')}</option>
              {groups.data.map((g) => (
                <option key={g.id} value={g.id}>
                  {g.name}
                </option>
              ))}
            </select>
          )}
        </FormField>
      ) : (
        <p className="note">{tr('helpdesk.requestCard.inGroup', { group: r.group?.name ?? t('helpdesk.requestCard.noGroup') })}</p>
      )}
      {r.group && r.group.sharing !== 'none' ? (
        <p className="note">
          {r.private
            ? t('helpdesk.requestCard.keptFromGroup', { group: r.group.name })
            : t(r.group.sharing === 'comment' ? 'helpdesk.requestCard.groupAnswers' : 'helpdesk.requestCard.groupReads', { group: r.group.name })}
        </p>
      ) : null}
      {r.group && r.group.sharing !== 'none' && canEdit ? (
        <label className="check">
          <input type="checkbox" checked={privateShown} disabled={change.isPending} onChange={(e) => change.mutate({ private: e.target.checked })} />
          {t('helpdesk.requestCard.keepFromGroup', { group: r.group.name })}
        </label>
      ) : null}
      {said ? <Said text={said.text} tone={said.bad ? 'bad' : undefined} /> : null}
    </div>
  );
}

/** Who asked, through the help desk, and where it stands against its first-response target. */
export function RequestCard({ issue, canEdit = false }: { issue: IssueDetail; canEdit?: boolean }) {
  const info = useRequestInfo(issue);
  const r = info.data;
  if (!r) return null;
  return (
    <section className="card side-card stack tight" aria-labelledby="request-title">
      <h2 id="request-title">{t('helpdesk.requestCard.helpDeskRequest')}</h2>
      <Who kind="person" name={r.requester.name} about={r.requester.email} small />
      <RequestGroup issue={issue} r={r} canEdit={canEdit} />
      {r.sla.clocks.length ? <RequestSla issueId={issue.id} r={r} canReply /> : <SlaBadge sla={r.firstResponse} since={r.createdAt} />}
      <p className="note">
        {r.via === 'email' ? t('helpdesk.requestCard.theyWroteInByEmail') : ''}
        {r.emailMuted
          ? t('helpdesk.requestCard.theyStoppedEmailsAboutIt')
          : t('helpdesk.requestCard.publicRepliesAndChangesOf')}
      </p>
    </section>
  );
}

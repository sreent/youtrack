import type { CustomerGroup, HelpdeskRequest, IssueDetail, RemovedPasskeys, Sla } from '@a4a/shared';
import { Badge } from '../../components/Badges';
import { Who } from '../../components/Who';
import { inboxKeys, useRequestInfo } from '../notifications/api';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api, get, patch } from '../../api/client';
import { Confirm } from '../common/Confirm';
import { errorText, FormField, Said } from '../common/bits';
import { RequestSla } from './Sla';
import { RequestCcs } from './RequestCcs';
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
  // What was chosen shows from the change itself until the save settles: a mutation's own pending
  // state comes a tick later, and meanwhile a control would show its old value.
  const [asked, setAsked] = useState<{ group?: string | null; private?: boolean } | null>(null);
  const change = useMutation({
    mutationFn: (body: { group?: string | null; private?: boolean }) => patch<HelpdeskRequest>(`/issues/${issue.id}/request`, body),
    onSuccess: (next) => {
      qc.setQueryData(inboxKeys.request(issue.id), next);
      void qc.invalidateQueries({ queryKey: ['issues', 'one', issue.id] });
      setSaid({ text: t('helpdesk.sla.saved') });
    },
    onError: (e) => setSaid({ text: errorText(e), bad: true }),
    onSettled: () => setAsked(null),
  });
  const ask = (body: { group?: string | null; private?: boolean }) => (setAsked(body), change.mutate(body));
  const busy = asked !== null || change.isPending;
  if (!r.group && !groups.data?.length) return null;
  const groupShown = asked?.group !== undefined ? (asked.group ?? '') : (r.group?.id ?? '');
  const privateShown = asked?.private !== undefined ? asked.private : r.private;
  return (
    <div className="stack tight">
      {canEdit && groups.data?.length ? (
        <FormField label={t('helpdesk.requestCard.customerGroup')}>
          {(id) => (
            <select id={id} value={groupShown} disabled={busy} onChange={(e) => ask({ group: e.target.value || null })}>
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
          <input type="checkbox" checked={privateShown} disabled={busy} onChange={(e) => ask({ private: e.target.checked })} />
          {t('helpdesk.requestCard.keepFromGroup', { group: r.group.name })}
        </label>
      ) : null}
      {said ? <Said text={said.text} tone={said.bad ? 'bad' : undefined} /> : null}
    </div>
  );
}

/**
 * How many passkeys its requester signs in to the portal with (D69), never which; and, for the desk's
 * managers and administrators, a way to remove them, as for a lost device.
 */
function RequesterPasskeys({ issue, r, canManage }: { issue: IssueDetail; r: HelpdeskRequest; canManage: boolean }) {
  const qc = useQueryClient();
  const [said, setSaid] = useState<{ text: string; bad?: boolean } | null>(null);
  const remove = useMutation({
    mutationFn: () => api<RemovedPasskeys>('DELETE', `/issues/${issue.id}/request/passkeys`),
    onSuccess: (x) => {
      setSaid({ text: t('helpdesk.requestCard.passkeysRemoved', { n: x.removed }) });
      void qc.invalidateQueries({ queryKey: inboxKeys.request(issue.id) });
    },
    onError: (e) => setSaid({ text: errorText(e), bad: true }),
  });
  if (!r.requester.passkeys && !said) return null;
  return (
    <div className="stack tight">
      {r.requester.passkeys ? (
        <div className="cluster">
          <p className="note">{t('helpdesk.requestCard.passkeys', { n: r.requester.passkeys })}</p>
          {canManage ? (
            <Confirm
              small
              label={t('helpdesk.requestCard.removePasskeys')}
              title={t('helpdesk.requestCard.removePasskeysTitle', { name: r.requester.name })}
              about={t('helpdesk.requestCard.removePasskeysAbout', { name: r.requester.name })}
              confirm={t('helpdesk.requestCard.removePasskeysIt')}
              disabled={remove.isPending}
              onConfirm={() => remove.mutate()}
            />
          ) : null}
        </div>
      ) : null}
      {said ? <Said text={said.text} tone={said.bad ? 'bad' : undefined} /> : null}
    </div>
  );
}

/** Who asked, through the help desk, where it stands against its first-response target, its customer group (D56), and who is copied (D57). */
export function RequestCard({ issue, canEdit = false, canManage = false }: { issue: IssueDetail; canEdit?: boolean; canManage?: boolean }) {
  const info = useRequestInfo(issue);
  const r = info.data;
  if (!r) return null;
  return (
    <section className="card side-card stack tight" aria-labelledby="request-title">
      <h2 id="request-title">{t('helpdesk.requestCard.helpDeskRequest')}</h2>
      <Who kind="person" name={r.requester.name} about={r.requester.email} small />
      <RequesterPasskeys issue={issue} r={r} canManage={canManage} />
      <RequestGroup issue={issue} r={r} canEdit={canEdit} />
      {r.sla.clocks.length ? <RequestSla issueId={issue.id} r={r} canReply /> : <SlaBadge sla={r.firstResponse} since={r.createdAt} />}
      <p className="note">
        {r.via === 'email' ? t('helpdesk.requestCard.theyWroteInByEmail') : ''}
        {r.emailMuted
          ? t('helpdesk.requestCard.theyStoppedEmailsAboutIt')
          : t('helpdesk.requestCard.publicRepliesAndChangesOf')}
      </p>
      <RequestCcs issue={issue.id} r={r} canEdit={canEdit} />
    </section>
  );
}

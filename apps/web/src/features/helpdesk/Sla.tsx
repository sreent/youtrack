import type { DeskMailbox, HelpdeskRequest, Project, SlaClock, SlaPolicy, SlaReport } from '@a4a/shared';
import { periodWords } from '../common/format';
import { parsePeriod } from '@a4a/shared/periods';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { del, get, patch, post, put } from '../../api/client';
import { keys } from '../../api/queries';
import { Badge } from '../../components/Badges';
import { errorText, FormField, Said } from '../common/bits';
import { span } from './RequestCard';
import { intlLocale, t, tr, weekdayNames } from '../../i18n';

const TARGET = { first_response: t('helpdesk.sla.firstResponse'), resolution: t('helpdesk.sla.resolution') } as const;
const DAYS = weekdayNames();

/** One target as it stands, in Ocean's grammar: counting (plain), at risk (warn), past (bad), met (good), paused (idle). */
export function ClockLine({ c, now = Date.now() }: { c: SlaClock; now?: number }) {
  const due = c.dueAt ? new Date(c.dueAt).getTime() : null;
  const name = TARGET[c.target];
  switch (c.state) {
    case 'running':
      return <Badge title={c.dueAt ? t('helpdesk.sla.due', { toLocaleString: new Date(c.dueAt).toLocaleString(intlLocale()) }) : undefined}>{tr('helpdesk.sla.dueIn', { name: name, v: due ? span(due - now) : t('helpdesk.sla.ofWorkingTime', { formatPeriod: periodWords(c.leftMinutes) }) })}</Badge>;
    case 'at_risk':
      return <Badge tone="warn" title={c.dueAt ? t('helpdesk.sla.due', { toLocaleString: new Date(c.dueAt).toLocaleString(intlLocale()) }) : undefined}>{tr('helpdesk.sla.atRiskDueIn', { name: name, v: due ? span(due - now) : periodWords(c.leftMinutes) })}</Badge>;
    case 'paused':
      return <Badge tone="idle">{tr('helpdesk.sla.pausedLeft', { name: name, formatPeriod: periodWords(Math.max(c.leftMinutes, 0)) })}</Badge>;
    case 'breached':
      return <Badge tone="bad">{tr('helpdesk.sla.pastItsTarget', { name: name, v: c.breachedAt ? span(now - new Date(c.breachedAt).getTime()) : '' })}</Badge>;
    case 'met':
      return <Badge tone="good">{tr('helpdesk.sla.metWithToSpare', { name: name, formatPeriod: periodWords(Math.max(c.leftMinutes, 0)) })}</Badge>;
    default:
      return <Badge>{tr('helpdesk.sla.missedItsTarget', { name: name })}</Badge>;
  }
}

/** A request's SLA on its page: its policy, each target's clock, and a way to invite its requester to the portal. */
export function RequestSla({ issueId, r, canReply }: { issueId: string; r: HelpdeskRequest; canReply: boolean }) {
  const [said, setSaid] = useState<{ text: string; bad?: boolean } | null>(null);
  const invite = useMutation({
    mutationFn: () => post(`/issues/${issueId}/request/invite`),
    onSuccess: () => setSaid({ text: t('helpdesk.sla.getsALinkToSign', { name: r.requester.name }) }),
    onError: (e) => setSaid({ text: errorText(e), bad: true }),
  });
  return (
    <div className="stack tight" aria-label={t('helpdesk.sla.itsSla')}>
      {r.sla.clocks.length ? (
        <>
          <p className="note">
            {r.sla.policy ? `${r.sla.policy.name}` : t('helpdesk.sla.firstResponseTarget')}
            {r.sla.businessHours ? t('helpdesk.sla.inWorkingHours') : t('helpdesk.sla.roundTheClock')}
            {t('helpdesk.sla.itWaitsOnItsRequester', { waiting: r.sla.waiting ? 'yes' : 'no' })}
          </p>
          <ul className="chips" aria-label={t('helpdesk.sla.targets')}>
            {r.sla.clocks.map((c) => (
              <li key={c.target}>
                <ClockLine c={c} />
              </li>
            ))}
          </ul>
        </>
      ) : null}
      {canReply ? (
        <div className="cluster">
          <button type="button" className="link" onClick={() => invite.mutate()} disabled={invite.isPending}>{tr('helpdesk.sla.inviteToThePortal', { name: r.requester.name })}</button>
        </div>
      ) : null}
      {said ? <Said text={said.text} tone={said.bad ? 'bad' : undefined} /> : null}
    </div>
  );
}

function minutesOf(text: string): number | null {
  const t = text.trim();
  if (!t) return null;
  const n = parsePeriod(t);
  return n && n > 0 ? n : NaN;
}

/** A desk's SLA: its working hours, the states it waits on its requester in, its policies, and how they've gone. */
export function SlaSettings({ project, canEdit }: { project: Project; canEdit: boolean }) {
  const qc = useQueryClient();
  const h = project.settings.helpdesk;
  const bh = h.businessHours;
  const [zone, setZone] = useState(bh?.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone);
  const [days, setDays] = useState<number[]>(bh ? [...new Set(bh.hours.map((x) => x.day))] : [1, 2, 3, 4, 5]);
  const [from, setFrom] = useState(bh?.hours[0]?.from ?? '09:00');
  const [to, setTo] = useState(bh?.hours[0]?.to ?? '17:00');
  const [holidays, setHolidays] = useState((bh?.holidays ?? []).join('\n'));
  const [counting, setCounting] = useState(bh ? 'hours' : 'always');
  const [waiting, setWaiting] = useState(h.waitingStates.join(', '));
  const [resume, setResume] = useState(h.resumeState ?? '');
  const [said, setSaid] = useState<{ text: string; bad?: boolean } | null>(null);
  const list = (s: string) => s.split(',').map((x) => x.trim()).filter(Boolean);
  const save = useMutation({
    mutationFn: () =>
      patch<Project>(`/projects/${project.key}`, {
        settings: {
          helpdesk: {
            businessHours:
              counting === 'always'
                ? null
                : { timeZone: zone.trim(), hours: days.sort().map((day) => ({ day, from, to })), holidays: holidays.split(/\s+/).map((x) => x.trim()).filter(Boolean) },
            waitingStates: list(waiting),
            resumeState: resume.trim() || null,
          },
        },
      }),
    onSuccess: (p) => {
      qc.setQueryData(keys.project(p.key), p);
      setSaid({ text: t('helpdesk.sla.savedOpenRequestsFollowIt') });
    },
    onError: (e) => setSaid({ text: errorText(e), bad: true }),
  });

  const policies = useQuery({ queryKey: ['sla-policies', project.key], queryFn: () => get<SlaPolicy[]>(`/projects/${project.key}/sla-policies`) });
  const report = useQuery({ queryKey: ['sla-report', project.key], queryFn: () => get<SlaReport>(`/projects/${project.key}/sla-report`), enabled: Boolean(policies.data?.length) });
  const [p, setP] = useState({ name: '', query: '', first: '', resolution: '', warn: '1h' });
  const [pSaid, setPSaid] = useState<{ text: string; bad?: boolean } | null>(null);
  const add = useMutation({
    mutationFn: () =>
      post<SlaPolicy>(`/projects/${project.key}/sla-policies`, {
        name: p.name,
        query: p.query,
        firstResponseMinutes: minutesOf(p.first),
        resolutionMinutes: minutesOf(p.resolution),
        warnMinutes: minutesOf(p.warn) ?? 0,
      }),
    onSuccess: (made) => {
      void qc.invalidateQueries({ queryKey: ['sla-policies', project.key] });
      void qc.invalidateQueries({ queryKey: keys.project(project.key) });
      setP({ name: '', query: '', first: '', resolution: '', warn: '1h' });
      setPSaid({ text: t('helpdesk.sla.coversWhatItMatchesFrom', { name: made.name }) });
    },
    onError: (e) => setPSaid({ text: errorText(e), bad: true }),
  });
  const remove = useMutation({
    mutationFn: (id: string) => del(`/projects/${project.key}/sla-policies/${id}`),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['sla-policies', project.key] }),
  });

  return (
    <div className="stack">
      <form
        className="form"
        aria-label={t('helpdesk.sla.workingHoursAndWaiting')}
        onSubmit={(e) => {
          e.preventDefault();
          save.mutate();
        }}
      >
        <fieldset className="unframed form" disabled={!canEdit || save.isPending}>
          <div className="modes" role="group" aria-label={t('helpdesk.sla.targetsCount')}>
            <button type="button" aria-pressed={counting === 'always'} onClick={() => setCounting('always')}>{t('helpdesk.sla.everyHour')}</button>
            <button type="button" aria-pressed={counting === 'hours'} onClick={() => setCounting('hours')}>{t('helpdesk.sla.workingHours')}</button>
          </div>
          {counting === 'hours' ? (
            <>
              <FormField label={t('helpdesk.sla.timeZone')} help={t('helpdesk.sla.anIanaNameSuchAs')}>
                {(id, help) => <input id={id} value={zone} onChange={(e) => setZone(e.target.value)} aria-describedby={help} />}
              </FormField>
              <div className="cluster" role="group" aria-label={t('helpdesk.sla.workingDays')}>
                {DAYS.map((d, i) => (
                  <label key={d} className="check">
                    <input type="checkbox" checked={days.includes(i)} onChange={(e) => setDays((x) => (e.target.checked ? [...x, i] : x.filter((y) => y !== i)))} />
                    {d}
                  </label>
                ))}
              </div>
              <FormField label={t('helpdesk.sla.from')}>{(id) => <input id={id} type="time" value={from} onChange={(e) => setFrom(e.target.value)} />}</FormField>
              <FormField label={t('helpdesk.sla.to')}>{(id) => <input id={id} type="time" value={to} onChange={(e) => setTo(e.target.value)} />}</FormField>
              <FormField label={t('helpdesk.sla.holidays')} help={t('helpdesk.sla.daysOffAsYyyyMm')}>
                {(id, help) => <textarea id={id} rows={3} value={holidays} onChange={(e) => setHolidays(e.target.value)} aria-describedby={help} />}
              </FormField>
            </>
          ) : null}
          <FormField label={t('helpdesk.sla.waitingStates')} help={t('helpdesk.sla.statesInWhichARequest')}>
            {(id, help) => <input id={id} value={waiting} placeholder={t('helpdesk.sla.waitingForReporter')} onChange={(e) => setWaiting(e.target.value)} aria-describedby={help} />}
          </FormField>
          <FormField label={t('helpdesk.sla.whenTheyAnswerMoveIt')} help={t('helpdesk.sla.aStateOrLeaveIt')}>
            {(id, help) => <input id={id} value={resume} placeholder={t('helpdesk.sla.open')} onChange={(e) => setResume(e.target.value)} aria-describedby={help} />}
          </FormField>
          <div className="cluster end">
            <button type="submit" className="primary">{t('helpdesk.sla.saveWorkingHours')}</button>
          </div>
        </fieldset>
        {said ? <Said text={said.text} tone={said.bad ? 'bad' : undefined} /> : null}
      </form>

      <section className="stack" aria-label={t('helpdesk.sla.slaPolicies')}>
        <h3>{t('helpdesk.sla.policies')}</h3>
        {policies.data?.length ? (
          <ol className="stack">
            {policies.data.map((x) => (
              <li key={x.id} className="stack tight">
                <strong>{x.name}</strong>
                <p className="note">{tr('helpdesk.sla.atRiskBefore', { v: x.query ? t('helpdesk.sla.when', { query: x.query }) : t('helpdesk.sla.everyRequest'), v2: x.firstResponseMinutes ? t('helpdesk.sla.firstResponseIn', { formatPeriod: periodWords(x.firstResponseMinutes) }) : t('helpdesk.sla.noFirstResponseTarget'), v3: x.resolutionMinutes ? t('helpdesk.sla.resolvedIn', { formatPeriod: periodWords(x.resolutionMinutes) }) : t('helpdesk.sla.noResolutionTarget'), v4: x.warnMinutes ? periodWords(x.warnMinutes) : '', warn: x.warnMinutes ? 'yes' : 'no' })}</p>
                {canEdit ? (
                  <button type="button" className="link" onClick={() => remove.mutate(x.id)} aria-label={t('helpdesk.sla.deleteThePolicy', { name: x.name })}>{t('helpdesk.sla.delete')}</button>
                ) : null}
              </li>
            ))}
          </ol>
        ) : (
          <p className="note">{tr('helpdesk.sla.noPoliciesYet', { v: h.firstResponseHours ? t('helpdesk.sla.everyRequestHasItsHour', { firstResponseHours: h.firstResponseHours }) : '' })}</p>
        )}
        {canEdit ? (
          <form
            className="form"
            aria-label={t('helpdesk.sla.addAPolicy')}
            onSubmit={(e) => {
              e.preventDefault();
              add.mutate();
            }}
          >
            <FormField label={t('helpdesk.sla.name')}>{(id) => <input id={id} required value={p.name} onChange={(e) => setP({ ...p, name: e.target.value })} />}</FormField>
            <FormField label={t('helpdesk.sla.requestsItCovers')} help={t('helpdesk.sla.aSearchSuchAsPriority')}>
              {(id, help) => <input id={id} value={p.query} onChange={(e) => setP({ ...p, query: e.target.value })} aria-describedby={help} />}
            </FormField>
            <FormField label={t('helpdesk.sla.firstResponseWithin')}>{(id) => <input id={id} placeholder="4h" value={p.first} onChange={(e) => setP({ ...p, first: e.target.value })} />}</FormField>
            <FormField label={t('helpdesk.sla.resolvedWithin')}>{(id) => <input id={id} placeholder="3d" value={p.resolution} onChange={(e) => setP({ ...p, resolution: e.target.value })} />}</FormField>
            <FormField label={t('helpdesk.sla.atRiskBefore2')}>{(id) => <input id={id} value={p.warn} onChange={(e) => setP({ ...p, warn: e.target.value })} />}</FormField>
            <div className="cluster end">
              <button type="submit" disabled={add.isPending || !p.name.trim()}>{t('helpdesk.sla.addThePolicy')}</button>
            </div>
            {pSaid ? <Said text={pSaid.text} tone={pSaid.bad ? 'bad' : undefined} /> : null}
          </form>
        ) : null}
      </section>

      {report.data?.weeks.some((w) => w.policies.length) ? (
        <section aria-label={t('helpdesk.sla.metAndBreachedPerWeek')}>
          <h3>{t('helpdesk.sla.metAndBreachedPerWeek')}</h3>
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th scope="col">{t('helpdesk.sla.weekOf')}</th>
                  <th scope="col">{t('helpdesk.sla.policy')}</th>
                  <th scope="col">{t('helpdesk.sla.firstResponseMet')}</th>
                  <th scope="col">{t('helpdesk.sla.breached')}</th>
                  <th scope="col">{t('helpdesk.sla.resolutionMet')}</th>
                  <th scope="col">{t('helpdesk.sla.breached')}</th>
                </tr>
              </thead>
              <tbody>
                {report.data.weeks.flatMap((w) =>
                  w.policies.map((x) => (
                    <tr key={`${w.week}-${x.policy}`}>
                      <td>{w.week}</td>
                      <td>{x.policy}</td>
                      <td>{x.firstResponse.met}</td>
                      <td>{x.firstResponse.breached}</td>
                      <td>{x.resolution.met}</td>
                      <td>{x.resolution.breached}</td>
                    </tr>
                  )),
                )}
              </tbody>
            </table>
          </div>
        </section>
      ) : null}

      {report.data?.groups.length ? (
        <section aria-label={t('helpdesk.sla.byCustomerGroup')}>
          <h3>{t('helpdesk.sla.byCustomerGroup')}</h3>
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th scope="col">{t('helpdesk.sla.customerGroup')}</th>
                  <th scope="col">{t('helpdesk.sla.firstResponseMet')}</th>
                  <th scope="col">{t('helpdesk.sla.breached')}</th>
                  <th scope="col">{t('helpdesk.sla.resolutionMet')}</th>
                  <th scope="col">{t('helpdesk.sla.breached')}</th>
                </tr>
              </thead>
              <tbody>
                {report.data.groups.map((x) => (
                  <tr key={x.group ?? ''}>
                    <td>{x.group ?? t('helpdesk.sla.noGroup')}</td>
                    <td>{x.firstResponse.met}</td>
                    <td>{x.firstResponse.breached}</td>
                    <td>{x.resolution.met}</td>
                    <td>{x.resolution.breached}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ) : null}
    </div>
  );
}

/** A desk's own mailbox and the name its mail comes from (D45). The mailbox is an administrator's to set. */
export function DeskMailboxSettings({ project }: { project: Project }) {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['desk-mailbox', project.key], queryFn: () => get<DeskMailbox>(`/projects/${project.key}/helpdesk/mailbox`), retry: false });
  const [url, setUrl] = useState('');
  const [name, setName] = useState<string | null>(null);
  const [said, setSaid] = useState<{ text: string; bad?: boolean } | null>(null);
  const save = useMutation({
    mutationFn: (body: { imapUrl?: string | null; fromName?: string | null }) => put<DeskMailbox>(`/projects/${project.key}/helpdesk/mailbox`, body),
    onSuccess: (m) => {
      qc.setQueryData(['desk-mailbox', project.key], m);
      setUrl('');
      setSaid({ text: t('helpdesk.sla.saved') });
    },
    onError: (e) => setSaid({ text: errorText(e), bad: true }),
  });
  if (q.error) return null;
  const m = q.data;
  return (
    <div className="stack" aria-label={t('helpdesk.sla.itsOwnMailbox')}>
      <p className="note">
        {m?.imap ? t('helpdesk.sla.readsAt', { user: m.imap.user, host: m.imap.host, folder: m.imap.folder, v: m.lastReadAt ? t('helpdesk.sla.lastRead', { toLocaleString: new Date(m.lastReadAt).toLocaleString(intlLocale()) }) : '' }) : t('helpdesk.sla.readsNoMailboxOfIts')}
        {m?.lastError ? t('helpdesk.sla.theLastReadFailed', { lastError: m.lastError }) : ''}
      </p>
      <form
        className="form"
        onSubmit={(e) => {
          e.preventDefault();
          save.mutate({ ...(url.trim() ? { imapUrl: url.trim() } : {}), ...(name !== null ? { fromName: name } : {}) });
        }}
      >
        <FormField label={t('helpdesk.sla.mailComesFrom')} help={t('helpdesk.sla.theNameBesideTheDesk')}>
          {(id, help) => <input id={id} value={name ?? m?.fromName ?? ''} placeholder={project.name} onChange={(e) => setName(e.target.value)} aria-describedby={help} />}
        </FormField>
        <FormField label={t('helpdesk.sla.itsOwnMailbox')} help={t('helpdesk.sla.imapsUserPasswordHostInbox')}>
          {(id, help) => <input id={id} type="password" autoComplete="off" value={url} onChange={(e) => setUrl(e.target.value)} aria-describedby={help} />}
        </FormField>
        <div className="cluster end">
          {m?.imap ? (
            <button type="button" onClick={() => save.mutate({ imapUrl: null })}>{t('helpdesk.sla.stopReadingIt')}</button>
          ) : null}
          <button type="submit" disabled={save.isPending || (!url.trim() && name === null)}>{t('helpdesk.sla.save')}</button>
        </div>
      </form>
      {said ? <Said text={said.text} tone={said.bad ? 'bad' : undefined} /> : null}
    </div>
  );
}

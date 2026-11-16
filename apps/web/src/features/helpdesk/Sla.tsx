import type { DeskMailbox, HelpdeskRequest, Project, SlaClock, SlaPolicy, SlaReport } from '@a4a/shared';
import { formatPeriod, parsePeriod } from '@a4a/shared/periods';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { del, get, patch, post, put } from '../../api/client';
import { keys } from '../../api/queries';
import { Badge } from '../../components/Badges';
import { errorText, FormField, Said } from '../common/bits';
import { span } from './RequestCard';

const TARGET = { first_response: 'First response', resolution: 'Resolution' } as const;
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** One target as it stands, in Ocean's grammar: counting (plain), at risk (warn), past (bad), met (good), paused (idle). */
export function ClockLine({ c, now = Date.now() }: { c: SlaClock; now?: number }) {
  const due = c.dueAt ? new Date(c.dueAt).getTime() : null;
  const name = TARGET[c.target];
  switch (c.state) {
    case 'running':
      return <Badge title={c.dueAt ? `Due ${new Date(c.dueAt).toLocaleString()}` : undefined}>{name} due in {due ? span(due - now) : `${formatPeriod(c.leftMinutes)} of working time`}</Badge>;
    case 'at_risk':
      return <Badge tone="warn" title={c.dueAt ? `Due ${new Date(c.dueAt).toLocaleString()}` : undefined}>{name} at risk: due in {due ? span(due - now) : formatPeriod(c.leftMinutes)}</Badge>;
    case 'paused':
      return <Badge tone="idle">{name} paused, {formatPeriod(Math.max(c.leftMinutes, 0))} left</Badge>;
    case 'breached':
      return <Badge tone="bad">{name} {c.breachedAt ? span(now - new Date(c.breachedAt).getTime()) : ''} past its target</Badge>;
    case 'met':
      return <Badge tone="good">{name} met, with {formatPeriod(Math.max(c.leftMinutes, 0))} to spare</Badge>;
    default:
      return <Badge>{name} missed its target</Badge>;
  }
}

/** A request's SLA on its page: its policy, each target's clock, and a way to invite its requester to the portal. */
export function RequestSla({ issueId, r, canReply }: { issueId: string; r: HelpdeskRequest; canReply: boolean }) {
  const [said, setSaid] = useState<{ text: string; bad?: boolean } | null>(null);
  const invite = useMutation({
    mutationFn: () => post(`/issues/${issueId}/request/invite`),
    onSuccess: () => setSaid({ text: `${r.requester.name} gets a link to sign in and see their requests.` }),
    onError: (e) => setSaid({ text: errorText(e), bad: true }),
  });
  return (
    <div className="stack tight" aria-label="Its SLA">
      {r.sla.clocks.length ? (
        <>
          <p className="note">
            {r.sla.policy ? `${r.sla.policy.name}` : 'First-response target'}
            {r.sla.businessHours ? ', in working hours' : ', round the clock'}
            {r.sla.waiting ? '. It waits on its requester: the clocks are paused until they answer.' : '.'}
          </p>
          <ul className="chips" aria-label="Targets">
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
          <button type="button" className="link" onClick={() => invite.mutate()} disabled={invite.isPending}>
            Invite {r.requester.name} to the portal
          </button>
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
  const [orgs, setOrgs] = useState(h.organizations.join(', '));
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
            organizations: list(orgs).map((x) => x.toLowerCase()),
          },
        },
      }),
    onSuccess: (p) => {
      qc.setQueryData(keys.project(p.key), p);
      setSaid({ text: 'Saved. Open requests follow it now.' });
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
      setPSaid({ text: `“${made.name}” covers what it matches from now, open requests too.` });
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
        aria-label="Working hours and waiting"
        onSubmit={(e) => {
          e.preventDefault();
          save.mutate();
        }}
      >
        <fieldset className="unframed form" disabled={!canEdit || save.isPending}>
          <div className="modes" role="group" aria-label="Targets count">
            <button type="button" aria-pressed={counting === 'always'} onClick={() => setCounting('always')}>
              Every hour
            </button>
            <button type="button" aria-pressed={counting === 'hours'} onClick={() => setCounting('hours')}>
              Working hours
            </button>
          </div>
          {counting === 'hours' ? (
            <>
              <FormField label="Time zone" help="An IANA name, such as Europe/Berlin: the hours are its wall clock's.">
                {(id, help) => <input id={id} value={zone} onChange={(e) => setZone(e.target.value)} aria-describedby={help} />}
              </FormField>
              <div className="cluster" role="group" aria-label="Working days">
                {DAYS.map((d, i) => (
                  <label key={d} className="check">
                    <input type="checkbox" checked={days.includes(i)} onChange={(e) => setDays((x) => (e.target.checked ? [...x, i] : x.filter((y) => y !== i)))} />
                    {d}
                  </label>
                ))}
              </div>
              <FormField label="From">{(id) => <input id={id} type="time" value={from} onChange={(e) => setFrom(e.target.value)} />}</FormField>
              <FormField label="To">{(id) => <input id={id} type="time" value={to} onChange={(e) => setTo(e.target.value)} />}</FormField>
              <FormField label="Holidays" help="Days off, as YYYY-MM-DD, one a line.">
                {(id, help) => <textarea id={id} rows={3} value={holidays} onChange={(e) => setHolidays(e.target.value)} aria-describedby={help} />}
              </FormField>
            </>
          ) : null}
          <FormField label="Waiting states" help="States in which a request waits on its requester, comma-separated: its clocks pause until they answer.">
            {(id, help) => <input id={id} value={waiting} placeholder="Waiting for reporter" onChange={(e) => setWaiting(e.target.value)} aria-describedby={help} />}
          </FormField>
          <FormField label="When they answer, move it to" help="A state, or leave it empty to keep its state.">
            {(id, help) => <input id={id} value={resume} placeholder="Open" onChange={(e) => setResume(e.target.value)} aria-describedby={help} />}
          </FormField>
          <FormField label="Organizations" help="Email domains whose requesters see each other's requests on the portal, comma-separated.">
            {(id, help) => <input id={id} value={orgs} placeholder="acme.com" onChange={(e) => setOrgs(e.target.value)} aria-describedby={help} />}
          </FormField>
          <div className="cluster end">
            <button type="submit" className="primary">
              Save working hours
            </button>
          </div>
        </fieldset>
        {said ? <Said text={said.text} tone={said.bad ? 'bad' : undefined} /> : null}
      </form>

      <section className="stack" aria-label="SLA policies">
        <h3>Policies</h3>
        {policies.data?.length ? (
          <ol className="stack">
            {policies.data.map((x) => (
              <li key={x.id} className="stack tight">
                <strong>{x.name}</strong>
                <p className="note">
                  {x.query ? `When ${x.query}` : 'Every request'}: {x.firstResponseMinutes ? `first response in ${formatPeriod(x.firstResponseMinutes)}` : 'no first-response target'},{' '}
                  {x.resolutionMinutes ? `resolved in ${formatPeriod(x.resolutionMinutes)}` : 'no resolution target'}; at risk {formatPeriod(x.warnMinutes || 0) || 'never'} before.
                </p>
                {canEdit ? (
                  <button type="button" className="link" onClick={() => remove.mutate(x.id)} aria-label={`Delete the policy ${x.name}`}>
                    Delete
                  </button>
                ) : null}
              </li>
            ))}
          </ol>
        ) : (
          <p className="note">No policies yet.{h.firstResponseHours ? ` Every request has its ${h.firstResponseHours}-hour first-response target.` : ''}</p>
        )}
        {canEdit ? (
          <form
            className="form"
            aria-label="Add a policy"
            onSubmit={(e) => {
              e.preventDefault();
              add.mutate();
            }}
          >
            <FormField label="Name">{(id) => <input id={id} required value={p.name} onChange={(e) => setP({ ...p, name: e.target.value })} />}</FormField>
            <FormField label="Requests it covers" help="A search, such as Priority: Critical; empty for every request. The first policy a request matches covers it.">
              {(id, help) => <input id={id} value={p.query} onChange={(e) => setP({ ...p, query: e.target.value })} aria-describedby={help} />}
            </FormField>
            <FormField label="First response within">{(id) => <input id={id} placeholder="4h" value={p.first} onChange={(e) => setP({ ...p, first: e.target.value })} />}</FormField>
            <FormField label="Resolved within">{(id) => <input id={id} placeholder="3d" value={p.resolution} onChange={(e) => setP({ ...p, resolution: e.target.value })} />}</FormField>
            <FormField label="At risk before">{(id) => <input id={id} value={p.warn} onChange={(e) => setP({ ...p, warn: e.target.value })} />}</FormField>
            <div className="cluster end">
              <button type="submit" disabled={add.isPending || !p.name.trim()}>
                Add the policy
              </button>
            </div>
            {pSaid ? <Said text={pSaid.text} tone={pSaid.bad ? 'bad' : undefined} /> : null}
          </form>
        ) : null}
      </section>

      {report.data?.weeks.some((w) => w.policies.length) ? (
        <section aria-label="Met and breached, per week">
          <h3>Met and breached, per week</h3>
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th scope="col">Week of</th>
                  <th scope="col">Policy</th>
                  <th scope="col">First response met</th>
                  <th scope="col">breached</th>
                  <th scope="col">Resolution met</th>
                  <th scope="col">breached</th>
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
      setSaid({ text: 'Saved.' });
    },
    onError: (e) => setSaid({ text: errorText(e), bad: true }),
  });
  if (q.error) return null;
  const m = q.data;
  return (
    <div className="stack" aria-label="Its own mailbox">
      <p className="note">
        {m?.imap ? `Reads ${m.imap.user} at ${m.imap.host}/${m.imap.folder}${m.lastReadAt ? `, last read ${new Date(m.lastReadAt).toLocaleString()}` : ''}.` : 'Reads no mailbox of its own.'}
        {m?.lastError ? ` The last read failed: ${m.lastError}` : ''}
      </p>
      <form
        className="form"
        onSubmit={(e) => {
          e.preventDefault();
          save.mutate({ ...(url.trim() ? { imapUrl: url.trim() } : {}), ...(name !== null ? { fromName: name } : {}) });
        }}
      >
        <FormField label="Mail comes from" help="The name beside the desk's address on mail to its requesters.">
          {(id, help) => <input id={id} value={name ?? m?.fromName ?? ''} placeholder={project.name} onChange={(e) => setName(e.target.value)} aria-describedby={help} />}
        </FormField>
        <FormField label="Its own mailbox" help="imaps://user:password@host/INBOX, set by an administrator. Kept sealed; the password is never shown again.">
          {(id, help) => <input id={id} type="password" autoComplete="off" value={url} onChange={(e) => setUrl(e.target.value)} aria-describedby={help} />}
        </FormField>
        <div className="cluster end">
          {m?.imap ? (
            <button type="button" onClick={() => save.mutate({ imapUrl: null })}>
              Stop reading it
            </button>
          ) : null}
          <button type="submit" disabled={save.isPending || (!url.trim() && name === null)}>
            Save
          </button>
        </div>
      </form>
      {said ? <Said text={said.text} tone={said.bad ? 'bad' : undefined} /> : null}
    </div>
  );
}

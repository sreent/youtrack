import type { BusinessHours, CustomerDirectoryEntry, CustomerGroup, CustomerGroupMember, CustomerSharing, PortalProvider, Project } from '@a4a/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { del, get, post, put } from '../../api/client';
import { useMembers } from '../../api/queries';
import { isOwnAgent } from '@a4a/shared/constants';
import { Badge } from '../../components/Badges';
import { errorText, FormField, Said } from '../common/bits';
import { Confirm } from '../common/Confirm';
import { formatList, t, tr, weekdayNames } from '../../i18n';
import { CustomerName } from './CustomerName';

const DAYS = weekdayNames();
const SHARING: Record<CustomerSharing, string> = {
  none: t('helpdesk.groups.sharingNone'),
  read: t('helpdesk.groups.sharingRead'),
  comment: t('helpdesk.groups.sharingComment'),
};
const groupsKey = (key: string) => ['customer-groups', key];
const list = (s: string) => s.split(/[\s,]+/).map((x) => x.trim().toLowerCase()).filter(Boolean);
const joined = (items: string[]) => formatList(items);

/** A group's settings, to make one or change one: its name, domains, sharing, agents and own hours. */
function GroupForm({ project, group, onDone }: { project: Project; group?: CustomerGroup; onDone: (g: CustomerGroup) => void }) {
  const qc = useQueryClient();
  const people = useMembers(project.key);
  const bh = group?.businessHours ?? null;
  const [name, setName] = useState(group?.name ?? '');
  const [domains, setDomains] = useState(group?.domains.join(', ') ?? '');
  const [sharing, setSharing] = useState<CustomerSharing>(group?.sharing ?? 'none');
  const [agents, setAgents] = useState<string[]>(group?.agents.map((a) => a.user.login) ?? []);
  // The identity provider its people sign in through, among the desk's (D63); empty: as the desk takes.
  const offered = project.settings.helpdesk.signIn.providers;
  const providers = useQuery({ queryKey: ['portal-providers'], queryFn: () => get<PortalProvider[]>('/portal-providers'), retry: false, enabled: offered.length > 0 });
  const [provider, setProvider] = useState(group?.provider?.id ?? '');
  // The customers other desks serve, to pick from when naming one (D56's revisit).
  const directory = useQuery({ queryKey: ['customer-directory'], queryFn: () => get<CustomerDirectoryEntry[]>('/customer-directory'), retry: false });
  // Less this desk's own groups: a name it has already is one it can't take again.
  const deskGroups = useQuery({ queryKey: groupsKey(project.key), queryFn: () => get<CustomerGroup[]>(`/projects/${project.key}/customer-groups`) });
  const known = useMemo(() => {
    const taken = new Set((deskGroups.data ?? []).map((g) => g.name.toLowerCase()));
    return (directory.data ?? []).filter((c) => !taken.has(c.name.toLowerCase()));
  }, [directory.data, deskGroups.data]);
  const [own, setOwn] = useState(Boolean(bh));
  const [zone, setZone] = useState(bh?.timeZone ?? project.settings.helpdesk.businessHours?.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone);
  const [days, setDays] = useState<number[]>(bh ? [...new Set(bh.hours.map((x) => x.day))] : [1, 2, 3, 4, 5]);
  const [from, setFrom] = useState(bh?.hours[0]?.from ?? '09:00');
  const [to, setTo] = useState(bh?.hours[0]?.to ?? '17:00');
  const [holidays, setHolidays] = useState((bh?.holidays ?? []).join('\n'));
  const [said, setSaid] = useState<string | null>(null);
  const save = useMutation({
    mutationFn: () => {
      const hours: BusinessHours | null = own ? { timeZone: zone.trim(), hours: [...days].sort().map((day) => ({ day, from, to })), holidays: list(holidays) } : null;
      const body = { name, domains: list(domains), sharing, businessHours: hours, agents, provider: provider || null };
      return group ? put<CustomerGroup>(`/projects/${project.key}/customer-groups/${group.id}`, body) : post<CustomerGroup>(`/projects/${project.key}/customer-groups`, body);
    },
    onSuccess: (g) => {
      void qc.invalidateQueries({ queryKey: groupsKey(project.key) });
      setSaid(null);
      onDone(g);
    },
    onError: (e) => setSaid(errorText(e)),
  });
  // a4a's own agents take no work (D34); a person who may not change issues is refused, and the problem says so.
  const candidates = (people.data ?? []).filter((m) => !isOwnAgent(m.user));
  return (
    <form
      className="form"
      aria-label={group ? t('helpdesk.groups.editGroup', { name: group.name }) : t('helpdesk.groups.add')}
      onSubmit={(e) => {
        e.preventDefault();
        save.mutate();
      }}
    >
      <fieldset className="unframed form" disabled={save.isPending}>
        <FormField label={t('helpdesk.groups.name')}>
          {(id) => (
            <CustomerName
              id={id}
              value={name}
              onChange={setName}
              onTake={(c) => {
                setName(c.name);
                // Its domains too, where none are written yet: a customer's domains are the same at every desk.
                if (!domains.trim()) setDomains(c.domains.join(', '));
              }}
              directory={known}
            />
          )}
        </FormField>
        <FormField label={t('helpdesk.groups.domains')} help={t('helpdesk.groups.domainsHelp')}>
          {(id, help) => <input id={id} value={domains} placeholder="acme.com" onChange={(e) => setDomains(e.target.value)} aria-describedby={help} />}
        </FormField>
        <FormField label={t('helpdesk.groups.sharing')}>
          {(id) => (
            <select id={id} value={sharing} onChange={(e) => setSharing(e.target.value as CustomerSharing)}>
              {(Object.keys(SHARING) as CustomerSharing[]).map((s) => (
                <option key={s} value={s}>
                  {SHARING[s]}
                </option>
              ))}
            </select>
          )}
        </FormField>
        {offered.length || group?.provider ? (
          <FormField label={t('helpdesk.groups.signsIn')} help={t('helpdesk.groups.signsInHelp')}>
            {(id, help) => (
              <select id={id} value={provider} onChange={(e) => setProvider(e.target.value)} aria-describedby={help}>
                <option value="">{t('helpdesk.groups.asTheDeskTakes')}</option>
                {(providers.data ?? (group?.provider ? [group.provider] : []))
                  .filter((x) => offered.includes(x.id) || x.id === group?.provider?.id)
                  .map((x) => (
                    <option key={x.id} value={x.id}>
                      {t('helpdesk.groups.throughAlone', { name: x.name })}
                    </option>
                  ))}
              </select>
            )}
          </FormField>
        ) : null}
        <fieldset className="unframed stack tight">
          <legend>{t('helpdesk.groups.agents')}</legend>
          <p className="note">{t('helpdesk.groups.agentsHelp')}</p>
          <div className="cluster">
            {candidates.map((m) => (
              <label key={m.user.id} className="check">
                <input
                  type="checkbox"
                  checked={agents.includes(m.user.login)}
                  onChange={(e) => setAgents((x) => (e.target.checked ? [...x, m.user.login] : x.filter((l) => l !== m.user.login)))}
                />
                {m.user.name}
              </label>
            ))}
          </div>
        </fieldset>
        <label className="check">
          <input type="checkbox" checked={own} onChange={(e) => setOwn(e.target.checked)} />
          {t('helpdesk.groups.ownHours')}
        </label>
        {own ? (
          <>
            <p className="note">{t('helpdesk.groups.ownHoursHelp')}</p>
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
        <div className="cluster end">
          <button type="submit" className="primary" disabled={!name.trim()}>
            {group ? t('helpdesk.groups.save') : t('helpdesk.groups.addTheGroup')}
          </button>
        </div>
      </fieldset>
      {said ? <Said text={said} tone="bad" /> : null}
    </form>
  );
}

/** Requesters added to a group by hand, whatever their domain says; added and taken out by email. */
function Members({ project, group, canEdit }: { project: Project; group: CustomerGroup; canEdit: boolean }) {
  const qc = useQueryClient();
  const key = ['customer-group-members', project.key, group.id];
  const members = useQuery({ queryKey: key, queryFn: () => get<CustomerGroupMember[]>(`/projects/${project.key}/customer-groups/${group.id}/members`) });
  const [email, setEmail] = useState('');
  const [said, setSaid] = useState<string | null>(null);
  const done = () => {
    void qc.invalidateQueries({ queryKey: key });
    void qc.invalidateQueries({ queryKey: groupsKey(project.key) });
  };
  const add = useMutation({
    mutationFn: () => post<CustomerGroupMember>(`/projects/${project.key}/customer-groups/${group.id}/members`, { email }),
    onSuccess: () => {
      setEmail('');
      setSaid(null);
      done();
    },
    onError: (e) => setSaid(errorText(e)),
  });
  const remove = useMutation({ mutationFn: (id: string) => del(`/projects/${project.key}/customer-groups/${group.id}/members/${id}`), onSuccess: done, onError: (e) => setSaid(errorText(e)) });
  return (
    <div className="stack tight">
      {members.data?.length ? (
        <ul className="list" aria-label={t('helpdesk.groups.members')}>
          {members.data.map((m) => (
            <li key={m.requester.id} className="list-row">
              <span>
                {m.requester.name} <span className="note">{m.requester.email}</span>
              </span>
              {canEdit ? (
                <button type="button" className="link" onClick={() => remove.mutate(m.requester.id)} aria-label={t('helpdesk.groups.removeMember', { email: m.requester.email })}>
                  {t('helpdesk.groups.remove')}
                </button>
              ) : null}
            </li>
          ))}
        </ul>
      ) : (
        <p className="note">{t('helpdesk.groups.noMembers')}</p>
      )}
      {canEdit ? (
        <form
          className="cluster"
          aria-label={t('helpdesk.groups.addMemberTo', { name: group.name })}
          onSubmit={(e) => {
            e.preventDefault();
            add.mutate();
          }}
        >
          <FormField label={t('helpdesk.groups.memberEmail')}>{(id) => <input id={id} type="email" required value={email} onChange={(e) => setEmail(e.target.value)} />}</FormField>
          <button type="submit" disabled={add.isPending || !email.trim()}>
            {t('helpdesk.groups.addMember')}
          </button>
        </form>
      ) : null}
      {said ? <Said text={said} tone="bad" /> : null}
    </div>
  );
}

/** A desk's customer groups (D56): who's in each, what they share, whose hours, and its dedicated agents. */
export function CustomerGroups({ project, canEdit }: { project: Project; canEdit: boolean }) {
  const qc = useQueryClient();
  const groups = useQuery({ queryKey: groupsKey(project.key), queryFn: () => get<CustomerGroup[]>(`/projects/${project.key}/customer-groups`) });
  const [editing, setEditing] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [said, setSaid] = useState<{ text: string; bad?: boolean } | null>(null);
  const remove = useMutation({
    mutationFn: (id: string) => del(`/projects/${project.key}/customer-groups/${id}`),
    onSuccess: () => void qc.invalidateQueries({ queryKey: groupsKey(project.key) }),
    onError: (e) => setSaid({ text: errorText(e), bad: true }),
  });
  return (
    <div className="stack">
      <p className="note">{t('helpdesk.groups.intro')}</p>
      {groups.data?.length ? (
        <ul className="stack" aria-label={t('helpdesk.groups.groups')}>
          {groups.data.map((g) => (
            <li key={g.id} className="stack tight">
              <div className="split">
                <strong>{g.name}</strong>
                {canEdit ? (
                  <span className="cluster">
                    <button type="button" className="link" onClick={() => setEditing(editing === g.id ? null : g.id)} aria-label={t('helpdesk.groups.editGroup', { name: g.name })}>
                      {t('helpdesk.groups.edit')}
                    </button>
                    <Confirm
                      small
                      label={t('helpdesk.groups.delete')}
                      name={t('helpdesk.groups.deleteGroup', { name: g.name })}
                      title={t('helpdesk.groups.deleteTitle', { name: g.name })}
                      about={t('helpdesk.groups.deleteAbout')}
                      confirm={t('helpdesk.groups.deleteIt')}
                      disabled={remove.isPending}
                      onConfirm={() => remove.mutate(g.id)}
                    />
                  </span>
                ) : null}
              </div>
              <p className="note">
                {tr('helpdesk.groups.summary', {
                  domains: g.domains.length ? t('helpdesk.groups.byDomains', { domains: joined(g.domains) }) : t('helpdesk.groups.byHandOnly'),
                  sharing: SHARING[g.sharing],
                  hours: g.businessHours ? t('helpdesk.groups.inItsHours', { zone: g.businessHours.timeZone }) : t('helpdesk.groups.inDeskHours'),
                  members: g.members,
                  open: g.openRequests,
                })}
              </p>
              {g.provider ? <p className="note">{t('helpdesk.groups.signsInThrough', { name: g.provider.name })}</p> : null}
              {g.agents.length ? (
                <ul className="chips" aria-label={t('helpdesk.groups.agents')}>
                  {g.agents.map((a) =>
                    a.assignable ? (
                      <li key={a.user.id}>
                        <Badge>{a.user.name}</Badge>
                      </li>
                    ) : (
                      <li key={a.user.id}>
                        <Badge tone="warn">{t('helpdesk.groups.cantBeGiven', { name: a.user.name })}</Badge>
                      </li>
                    ),
                  )}
                </ul>
              ) : (
                <p className="note">{t('helpdesk.groups.noAgents')}</p>
              )}
              {editing === g.id ? (
                <GroupForm
                  project={project}
                  group={g}
                  onDone={() => {
                    setEditing(null);
                    setSaid({ text: t('helpdesk.groups.saved') });
                  }}
                />
              ) : null}
              <details>
                <summary>{t('helpdesk.groups.membersCount', { n: g.members })}</summary>
                <Members project={project} group={g} canEdit={canEdit} />
              </details>
            </li>
          ))}
        </ul>
      ) : groups.isLoading ? null : (
        <p className="note">{t('helpdesk.groups.none')}</p>
      )}
      {said ? <Said text={said.text} tone={said.bad ? 'bad' : undefined} /> : null}
      {canEdit ? (
        adding ? (
          <GroupForm
            project={project}
            onDone={() => {
              setAdding(false);
              setSaid({ text: t('helpdesk.groups.saved') });
            }}
          />
        ) : (
          <div className="cluster">
            <button type="button" onClick={() => setAdding(true)}>
              {t('helpdesk.groups.add')}
            </button>
          </div>
        )
      ) : null}
    </div>
  );
}

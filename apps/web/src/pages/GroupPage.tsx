import type { GroupDetail, User } from '@a4a/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { del, patch, post } from '../api/client';
import { useMe, useSetupStatus, useUsers } from '../api/queries';
import { ago } from '../components/Badges';
import { ErrorNote, Loading, PageHead } from '../components/States';
import { Avatar } from '../components/Who';
import { errorText, FormField, Said, Scroll } from '../features/common/bits';
import { Confirm } from '../features/common/Confirm';
import { comesFrom, groupKeys, useGroup } from '../features/groups/api';
import { providerNameOf } from '../features/groups/GroupsSection';
import { t, tr } from '../i18n';

function useRefresh(id: string) {
  const qc = useQueryClient();
  return () =>
    Promise.all([
      qc.invalidateQueries({ queryKey: groupKeys.one(id) }),
      qc.invalidateQueries({ queryKey: groupKeys.all }),
      // Someone's access may have changed: their projects, and what each lets them do.
      qc.invalidateQueries({ queryKey: ['projects'] }),
    ]);
}

function People({ group, admin, provider }: { group: GroupDetail; admin: boolean; provider: string | null }) {
  const refresh = useRefresh(group.id);
  const users = useUsers({ enabled: admin && !group.providerName });
  const [login, setLogin] = useState('');
  const [said, setSaid] = useState<{ text: string; bad?: boolean } | null>(null);
  const inIt = new Set(group.members.map((m) => m.user.id));
  const choices = (users.data ?? []).filter((u: User) => !u.banned && !inIt.has(u.id));
  const add = useMutation({
    mutationFn: () => post<GroupDetail>(`/groups/${group.id}/members`, { user: login }),
    onSuccess: () => {
      const who = choices.find((u) => u.login === login);
      setSaid({ text: t('page.group.isInNow', { v: who?.name ?? login, name: group.name }) });
      setLogin('');
      void refresh();
    },
    onError: (e) => setSaid({ text: errorText(e), bad: true }),
  });
  const remove = useMutation({
    mutationFn: (who: string) => del(`/groups/${group.id}/members/${who}`),
    onSuccess: () => void refresh(),
    onError: (e) => setSaid({ text: errorText(e), bad: true }),
  });
  const byHand = !group.providerName;
  return (
    <section className="card" aria-labelledby="group-people">
      <div className="section-head">
        <h2 id="group-people">{t('page.group.peopleInIt')}</h2>
        <span className="note">{comesFrom(group, provider)}</span>
      </div>
      {!byHand ? (
        <p className="note section-note">{tr('page.group.saysWhoIsInIt', { v: provider ?? t('page.group.theIdentityProvider'), providerName: group.providerName })}</p>
      ) : null}
      {!group.members.length ? <p className="note">{byHand ? t('page.group.nobodyIsInItYet') : t('page.group.nobodyHasSignedInFrom')}</p> : null}
      {group.members.length ? (
        <Scroll label={t('page.group.peopleIn', { name: group.name })}>
          <table className="figures middle">
            <thead>
              <tr>
                <th scope="col">{t('page.group.person')}</th>
                <th scope="col">{t('page.group.inItSince')}</th>
                {admin && byHand ? (
                  <th scope="col">
                    <span className="hidden">{t('page.group.change')}</span>
                  </th>
                ) : null}
              </tr>
            </thead>
            <tbody>
              {group.members.map((m) => {
                const name = m.user.isBot ? m.user.login : m.user.name;
                return (
                  <tr key={m.user.id}>
                    <th scope="row" className="row-head">
                      <span className="tw:flex tw:min-w-48 tw:items-center tw:gap-2">
                        <Avatar kind={m.user.isBot ? 'agent' : 'person'} name={name} small />
                        <span>
                          <span className="item-name">{name}</span>
                          <span className="item-about mono">{m.user.login}</span>
                        </span>
                      </span>
                    </th>
                    <td>
                      {ago(m.addedAt)}
                      <span className="item-about">{m.addedBy ? t('page.group.addedBy', { v: m.addedBy.isBot ? m.addedBy.login : m.addedBy.name }) : `from ${provider ?? 'the identity provider'}`}</span>
                    </td>
                    {admin && byHand ? (
                      <td className="fit">
                        <Confirm
                          small
                          label={t('page.group.takeOut')}
                          name={t('page.group.takeOut2', { name: name })}
                          title={t('page.group.takeOutOf', { name: name, name2: group.name })}
                          about={t('page.group.losesTheRolesGivesIn', { name: name, name2: group.name })}
                          confirm={t('page.group.takeThemOut')}
                          onConfirm={() => remove.mutate(m.user.login)}
                          disabled={remove.isPending}
                        />
                      </td>
                    ) : null}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </Scroll>
      ) : null}
      {admin && byHand ? (
        <form
          className="stack"
          onSubmit={(e) => {
            e.preventDefault();
            if (login) add.mutate();
          }}
        >
          <fieldset className="form-card adding stack">
            <legend>{t('page.group.putSomeoneInIt')}</legend>
            <div className="form-fields">
              <FormField label={t('page.group.person')}>
                {(fid) => (
                  <select id={fid} value={login} onChange={(e) => setLogin(e.target.value)} required>
                    <option value="">{t('page.group.chooseSomeone')}</option>
                    {choices.map((u) => (
                      <option key={u.id} value={u.login}>
                        {u.isBot ? t('page.group.bot', { login: u.login }) : u.name}
                      </option>
                    ))}
                  </select>
                )}
              </FormField>
            </div>
            <div className="cluster">
              <button type="submit" className="primary" disabled={!login || add.isPending}>
                {add.isPending ? t('page.group.adding') : t('page.group.putThemIn')}
              </button>
              <Said text={said?.text} tone={said?.bad ? 'bad' : undefined} />
            </div>
          </fieldset>
        </form>
      ) : (
        <Said text={said?.text} tone={said?.bad ? 'bad' : undefined} />
      )}
    </section>
  );
}

function Roles({ group }: { group: GroupDetail }) {
  return (
    <section className="card" aria-labelledby="group-roles">
      <div className="section-head">
        <h2 id="group-roles">{t('page.group.itsRolesInProjects')}</h2>
        <span className="note">{t('page.group.eachProjectSManagersGive')}</span>
      </div>
      {!group.roles.length ? <p className="note">{t('page.group.noProjectYouCanSee')}</p> : null}
      {group.roles.length ? (
        <Scroll label={t('page.group.rolesOf', { name: group.name })}>
          <table className="figures middle">
            <thead>
              <tr>
                <th scope="col">{t('page.group.project')}</th>
                <th scope="col">{t('page.group.itsRoleThere')}</th>
              </tr>
            </thead>
            <tbody>
              {group.roles.map((r) => (
                <tr key={r.project.id}>
                  <th scope="row" className="row-head">
                    <Link to={`/projects/${r.project.key}`}>{r.project.name}</Link>
                    <span className="item-about mono">{r.project.key}</span>
                  </th>
                  <td>{r.roleName}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Scroll>
      ) : null}
    </section>
  );
}

function Settings({ group, provider }: { group: GroupDetail; provider: string | null }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const refresh = useRefresh(group.id);
  const initial = { name: group.name, description: group.description, providerName: group.providerName ?? '' };
  const [form, setForm] = useState(initial);
  const [said, setSaid] = useState<{ text: string; bad?: boolean } | null>(null);
  const savedKey = JSON.stringify(initial);
  useEffect(() => setForm(JSON.parse(savedKey) as typeof initial), [savedKey]);
  const dirty = JSON.stringify(form) !== savedKey;
  // Saving empties it when it starts coming from the provider, or from another of its groups.
  const startsFromProvider = form.providerName.trim() !== '' && form.providerName.trim().toLowerCase() !== (group.providerName ?? '').toLowerCase();
  const save = useMutation({
    mutationFn: () => patch<GroupDetail>(`/groups/${group.id}`, { name: form.name.trim(), description: form.description.trim(), providerName: form.providerName.trim() || null }),
    onSuccess: (g) => {
      setSaid({ text: startsFromProvider ? t('page.group.savedIsEmptyNowPeople', { name: g.name }) : t('page.group.saved') });
      void refresh();
    },
    onError: (e) => setSaid({ text: errorText(e), bad: true }),
  });
  const remove = useMutation({
    mutationFn: () => del(`/groups/${group.id}`),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: groupKeys.all });
      void qc.invalidateQueries({ queryKey: ['projects'] });
      navigate('/admin');
    },
    onError: (e) => setSaid({ text: errorText(e), bad: true }),
  });
  const set = (k: keyof typeof initial) => (e: React.ChangeEvent<HTMLInputElement>) => setForm((f) => ({ ...f, [k]: e.target.value }));
  return (
    <section className="card" aria-labelledby="group-settings">
      <h2 id="group-settings">{t('page.group.theGroup')}</h2>
      <form
        className="form-fields"
        onSubmit={(e) => {
          e.preventDefault();
          save.mutate();
        }}
      >
        <FormField label={t('page.group.name')}>{(id) => <input id={id} value={form.name} onChange={set('name')} required maxLength={80} />}</FormField>
        <FormField label={t('page.group.whatItSFor')}>{(id) => <input id={id} value={form.description} onChange={set('description')} maxLength={500} />}</FormField>
        <FormField
          label={t('page.group.itsNameAtTheIdentity')}
          help={
            startsFromProvider
              ? t('page.group.savingEmptiesTheGroupFrom', { v: provider ?? 'the identity provider' })
              : group.providerName
                ? t('page.group.clearItToKeepThe')
                : t('page.group.optionalWithItSaysWho', { v: provider ?? 'the identity provider' })
          }
        >
          {(id, help) => <input id={id} aria-describedby={help} value={form.providerName} onChange={set('providerName')} maxLength={200} className="mono" placeholder={t('page.group.none')} />}
        </FormField>
        <div className="cluster tw:col-span-full">
          <button type="submit" disabled={!dirty || !form.name.trim() || save.isPending}>
            {save.isPending ? t('page.group.saving') : t('page.group.saveTheGroup')}
          </button>
          <span className="grow" />
          <Confirm
            small
            label={t('page.group.deleteIt')}
            title={t('page.group.deleteTheGroup', { name: group.name })}
            about={t('page.group.itsRolesInProjectsGo')}
            confirm={t('page.group.deleteIt')}
            onConfirm={() => remove.mutate()}
            disabled={remove.isPending}
          />
        </div>
        <Said text={said?.text} tone={said?.bad ? 'bad' : undefined} />
      </form>
    </section>
  );
}

/** One group: who is in it, its roles in projects, and (for administrators) the group itself. */
export default function GroupPage() {
  const { id = '' } = useParams();
  const group = useGroup(id);
  const me = useMe();
  const status = useSetupStatus();
  const admin = me.data?.auth.scopes.includes('admin') ?? false;
  const provider = providerNameOf(status.data);
  const crumbs = admin ? <Link to="/admin">{t('page.group.administration')}</Link> : null;
  if (group.isLoading) return <Loading what={t('page.group.theGroup2')} />;
  if (group.error || !group.data) {
    return (
      <>
        <PageHead title={t('page.group.group')} crumbs={crumbs} />
        <ErrorNote error={group.error} />
      </>
    );
  }
  const g = group.data;
  return (
    <>
      <PageHead
        title={g.name}
        crumbs={crumbs}
        about={g.description || t('page.group.aGroupOfPeopleA')}
        badges={g.providerName ? <span className="chip">{tr('page.group.from', { v: provider ?? 'the identity provider' })}</span> : null}
      />
      <People group={g} admin={admin} provider={provider} />
      <Roles group={g} />
      {admin ? <Settings group={g} provider={provider} /> : null}
    </>
  );
}

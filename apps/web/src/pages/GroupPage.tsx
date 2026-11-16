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
      setSaid({ text: `${who?.name ?? login} is in ${group.name} now.` });
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
        <h2 id="group-people">People in it</h2>
        <span className="note">{comesFrom(group, provider)}</span>
      </div>
      {!byHand ? (
        <p className="note section-note">
          {provider ?? 'The identity provider'} says who is in it: people join as they sign in, when it names “{group.providerName}” among their groups, and leave
          when it no longer does.
        </p>
      ) : null}
      {!group.members.length ? <p className="note">{byHand ? 'Nobody is in it yet.' : 'Nobody has signed in from it yet.'}</p> : null}
      {group.members.length ? (
        <Scroll label={`People in ${group.name}`}>
          <table className="figures middle">
            <thead>
              <tr>
                <th scope="col">Person</th>
                <th scope="col">In it since</th>
                {admin && byHand ? (
                  <th scope="col">
                    <span className="hidden">Change</span>
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
                      <span className="item-about">{m.addedBy ? `added by ${m.addedBy.isBot ? m.addedBy.login : m.addedBy.name}` : `from ${provider ?? 'the identity provider'}`}</span>
                    </td>
                    {admin && byHand ? (
                      <td className="fit">
                        <Confirm
                          small
                          label="Take out"
                          name={`Take out ${name}`}
                          title={`Take ${name} out of ${group.name}?`}
                          about={`${name} loses the roles ${group.name} gives in projects, unless they have them another way. You can put them back.`}
                          confirm="Take them out"
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
            <legend>Put someone in it</legend>
            <div className="form-fields">
              <FormField label="Person">
                {(fid) => (
                  <select id={fid} value={login} onChange={(e) => setLogin(e.target.value)} required>
                    <option value="">Choose someone</option>
                    {choices.map((u) => (
                      <option key={u.id} value={u.login}>
                        {u.isBot ? `${u.login} (bot)` : u.name}
                      </option>
                    ))}
                  </select>
                )}
              </FormField>
            </div>
            <div className="cluster">
              <button type="submit" className="primary" disabled={!login || add.isPending}>
                {add.isPending ? 'Adding…' : 'Put them in'}
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
        <h2 id="group-roles">Its roles in projects</h2>
        <span className="note">Each project’s managers give it one, under People and access.</span>
      </div>
      {!group.roles.length ? <p className="note">No project you can see gives it a role.</p> : null}
      {group.roles.length ? (
        <Scroll label={`Roles of ${group.name}`}>
          <table className="figures middle">
            <thead>
              <tr>
                <th scope="col">Project</th>
                <th scope="col">Its role there</th>
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
      setSaid({ text: startsFromProvider ? `Saved. ${g.name} is empty now: people join it as they sign in.` : 'Saved.' });
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
      <h2 id="group-settings">The group</h2>
      <form
        className="form-fields"
        onSubmit={(e) => {
          e.preventDefault();
          save.mutate();
        }}
      >
        <FormField label="Name">{(id) => <input id={id} value={form.name} onChange={set('name')} required maxLength={80} />}</FormField>
        <FormField label="What it's for">{(id) => <input id={id} value={form.description} onChange={set('description')} maxLength={500} />}</FormField>
        <FormField
          label="Its name at the identity provider"
          help={
            startsFromProvider
              ? `Saving empties the group: from then on ${provider ?? 'the identity provider'} says who is in it, as they sign in.`
              : group.providerName
                ? 'Clear it to keep the group by hand: whoever is in it stays.'
                : `Optional. With it, ${provider ?? 'the identity provider'} says who is in the group.`
          }
        >
          {(id, help) => <input id={id} aria-describedby={help} value={form.providerName} onChange={set('providerName')} maxLength={200} className="mono" placeholder="None" />}
        </FormField>
        <div className="cluster tw:col-span-full">
          <button type="submit" disabled={!dirty || !form.name.trim() || save.isPending}>
            {save.isPending ? 'Saving…' : 'Save the group'}
          </button>
          <span className="grow" />
          <Confirm
            small
            label="Delete it"
            title={`Delete the group ${group.name}?`}
            about={`Its roles in projects go with it, and its people lose them, unless they have them another way. Each project's history says so.`}
            confirm="Delete it"
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
  const crumbs = admin ? <Link to="/admin">Administration</Link> : null;
  if (group.isLoading) return <Loading what="the group" />;
  if (group.error || !group.data) {
    return (
      <>
        <PageHead title="Group" crumbs={crumbs} />
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
        about={g.description || 'A group of people. A project can give it a role, as it gives one to a person.'}
        badges={g.providerName ? <span className="chip">from {provider ?? 'the identity provider'}</span> : null}
      />
      <People group={g} admin={admin} provider={provider} />
      <Roles group={g} />
      {admin ? <Settings group={g} provider={provider} /> : null}
    </>
  );
}

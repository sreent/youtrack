import type { Role, Settings, TriageMode, User } from '@a4a/shared';
import { ROLES } from '@a4a/shared/constants';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { patch, post } from '../api/client';
import { keys, useMe, useSettings, useSetupStatus, useUsers } from '../api/queries';
import { ErrorNote, Loading, PageHead } from '../components/States';
import { Avatar } from '../components/Who';
import { ago } from '../components/Badges';
import { AdminOnly, errorText, FormField, Said, Scroll } from '../features/common/bits';
import { LadderChoice } from '../features/common/Ladder';
import { GroupsSection } from '../features/groups/GroupsSection';
import { TRIAGE_RUNGS } from '../features/projects/triage';
import { PeopleAtProviders } from '../features/vcs/People';

const ROLE_WORDS: Record<Role, string> = {
  admin: 'an administrator changes everything',
  member: 'a member reads and changes issues',
  viewer: 'a viewer reads',
};
const ROLE_NAMES: Record<Role, string> = { admin: 'Administrator', member: 'Member', viewer: 'Viewer' };

function num(v: string): number | null {
  if (v.trim() === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

type SignInWays = { sso: { name: string } | null; passwords: boolean };

/** How someone signs in, in words: "Password", "Corp ID", "Password and Corp ID". */
function signsInWith(user: User, ways: SignInWays): { words: string; about: string | null } {
  if (user.isBot) return { words: 'Tokens only', about: null };
  const providers = [...new Set((user.signIn?.identities ?? []).map((i) => i.provider))];
  const now = [...(user.signIn?.password && ways.passwords ? ['Password'] : []), ...providers];
  const last = (user.signIn?.identities ?? []).map((i) => i.lastSignInAt).filter((t): t is string => Boolean(t)).sort().at(-1);
  if (now.length) return { words: now.join(' and '), about: last ? `last ${ago(last)}` : null };
  if (ways.sso && user.email && user.signIn?.emailConfirmed) return { words: 'Not yet', about: `${ways.sso.name} finds them by email` };
  if (ways.sso && user.email) return { words: 'Not yet', about: 'once their email is confirmed' };
  return { words: 'Can’t yet', about: ways.sso ? 'Give them a password, or an email' : 'Give them a password' };
}

function PersonRow({ user, isMe, ways }: { user: User; isMe: boolean; ways: SignInWays }) {
  const qc = useQueryClient();
  const initial = {
    name: user.name,
    email: user.email ?? '',
    role: user.role,
    banned: user.banned,
    hourlyRate: user.hourlyRate === null ? '' : String(user.hourlyRate),
    capacity: String(user.capacityHoursPerDay),
  };
  const [form, setForm] = useState(initial);
  const [said, setSaid] = useState<{ text: string; bad?: boolean } | null>(null);
  const savedKey = JSON.stringify(initial);
  useEffect(() => setForm(JSON.parse(savedKey) as typeof initial), [savedKey]);
  const dirty = JSON.stringify(form) !== savedKey;
  const save = useMutation({
    mutationFn: () =>
      patch<User>(`/users/${user.id}`, {
        name: form.name.trim(),
        email: form.email.trim() || null,
        ...(isMe ? {} : { role: form.role, banned: form.banned }),
        hourlyRate: num(form.hourlyRate),
        capacityHoursPerDay: num(form.capacity) ?? 0,
      }),
    onSuccess: () => {
      setSaid({ text: 'Saved.' });
      void qc.invalidateQueries({ queryKey: keys.users });
      void qc.invalidateQueries({ queryKey: ['plan'] });
      void qc.invalidateQueries({ queryKey: ['projects'] });
      if (isMe) void qc.invalidateQueries({ queryKey: keys.me });
    },
    onError: (e) => setSaid({ text: errorText(e), bad: true }),
  });
  const label = (what: string) => `${what} of ${user.name}`;
  const how = signsInWith(user, ways);
  // An email people set for themselves isn't one single sign-on may find them by, until an administrator confirms it.
  const unconfirmed = Boolean(user.email) && user.signIn !== undefined && !user.signIn.emailConfirmed && form.email.trim() === (user.email ?? '');
  const confirm = useMutation({
    mutationFn: () => patch<User>(`/users/${user.id}`, { email: user.email }),
    onSuccess: () => {
      setSaid({ text: `${user.name}'s email is confirmed.` });
      void qc.invalidateQueries({ queryKey: keys.users });
    },
    onError: (e) => setSaid({ text: errorText(e), bad: true }),
  });
  return (
    <tr className={form.banned ? 'dimmed' : undefined}>
      <th scope="row" className="row-head">
        <span className="tw:flex tw:min-w-48 tw:items-center tw:gap-2">
          <Avatar kind={user.isBot ? 'agent' : 'person'} name={user.name} small />
          <span>
            <input
              value={form.name}
              onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
              aria-label={label('Name')}
              maxLength={100}
              required
              className="tw:w-44"
            />
            <span className="item-about">
              <span className="mono">{user.login}</span>
              {user.isBot ? (
                <>
                  {' '}
                  · <span className="chip">bot</span>
                </>
              ) : null}
              {isMe ? ' · you' : ''}
            </span>
          </span>
        </span>
      </th>
      <td>
        <input
          type="email"
          value={form.email}
          onChange={(e) => setForm((f) => ({ ...f, email: e.target.value }))}
          aria-label={label('Email')}
          placeholder="None"
          className="tw:w-48"
        />
        {unconfirmed ? (
          <span className="item-about">
            Not confirmed: single sign-on won’t find them by it, and their commits run no commands, until they confirm it by the link a4a mails, or you do.{' '}
            <button type="button" className="link" onClick={() => confirm.mutate()} disabled={confirm.isPending}>
              Confirm it
            </button>
          </span>
        ) : null}
      </td>
      <td>
        <span className="tw:block tw:min-w-36">
          {how.words}
          {how.about ? <span className="item-about">{how.about}</span> : null}
        </span>
      </td>
      <td>
        <select value={form.role} onChange={(e) => setForm((f) => ({ ...f, role: e.target.value as Role }))} aria-label={label('Role')} disabled={isMe}>
          {ROLES.map((r) => (
            <option key={r} value={r}>
              {r}
            </option>
          ))}
        </select>
      </td>
      <td>
        <input
          type="number"
          min={0}
          step="any"
          value={form.hourlyRate}
          onChange={(e) => setForm((f) => ({ ...f, hourlyRate: e.target.value }))}
          aria-label={label('Rate per hour')}
          placeholder="None"
          className="tw:w-26"
        />
      </td>
      <td>
        <input
          type="number"
          min={0}
          max={24}
          step={0.5}
          value={form.capacity}
          onChange={(e) => setForm((f) => ({ ...f, capacity: e.target.value }))}
          aria-label={label('Hours a day')}
          className="tw:w-26"
        />
      </td>
      <td>
        <label className="choice">
          <input
            type="checkbox"
            checked={!form.banned}
            onChange={(e) => setForm((f) => ({ ...f, banned: !e.target.checked }))}
            disabled={isMe}
            aria-label={`${user.name} is allowed in`}
          />
          <span aria-hidden="true">{form.banned ? 'Banned' : 'Allowed'}</span>
        </label>
      </td>
      <td className="fit">
        <button type="button" className="small" disabled={!dirty || !form.name.trim() || save.isPending} onClick={() => save.mutate()}>
          {save.isPending ? 'Saving…' : 'Save'}
        </button>
        <Said text={said?.text} tone={said?.bad ? 'bad' : undefined} />
      </td>
    </tr>
  );
}

function AddPerson() {
  const qc = useQueryClient();
  const blank = { login: '', name: '', email: '', password: '', role: 'member' as Role, isBot: false, hourlyRate: '', capacity: '8' };
  const [form, setForm] = useState(blank);
  const [said, setSaid] = useState<{ text: string; bad?: boolean } | null>(null);
  const add = useMutation({
    mutationFn: () =>
      post<User>('/users', {
        login: form.login.trim(),
        name: form.name.trim(),
        email: form.email.trim() || null,
        ...(form.password ? { password: form.password } : {}),
        role: form.role,
        isBot: form.isBot,
        hourlyRate: num(form.hourlyRate),
        capacityHoursPerDay: num(form.capacity) ?? 8,
      }),
    onSuccess: (u) => {
      setSaid({ text: u.isBot ? `${u.login} is added, as a bot.` : `${u.name} is added, and can sign in as ${u.login}.` });
      setForm(blank);
      void qc.invalidateQueries({ queryKey: keys.users });
    },
    onError: (e) => setSaid({ text: errorText(e), bad: true }),
  });
  const set = (k: keyof typeof blank) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
    setForm((f) => ({ ...f, [k]: e.target.type === 'checkbox' ? (e.target as HTMLInputElement).checked : e.target.value }));
  return (
    <form
      className="stack"
      onSubmit={(e) => {
        e.preventDefault();
        add.mutate();
      }}
    >
      <fieldset className="form-card adding stack">
        <legend>Add someone</legend>
        <div className="form-fields">
          <FormField label="Name">{(id) => <input id={id} value={form.name} onChange={set('name')} required maxLength={100} />}</FormField>
          <FormField label="Login">
            {(id) => (
              <input
                id={id}
                value={form.login}
                onChange={set('login')}
                required
                minLength={2}
                maxLength={40}
                pattern="[a-zA-Z0-9._\-]+"
                className="mono"
                autoComplete="off"
              />
            )}
          </FormField>
          <FormField label="Email">{(id) => <input id={id} type="email" value={form.email} onChange={set('email')} />}</FormField>
          <FormField
            label="Password"
            help={form.isBot ? "A bot doesn't sign in with a password." : 'At least 8 characters. They can change it on their profile.'}
          >
            {(id, help) => (
              <input
                id={id}
                aria-describedby={help}
                type="password"
                value={form.password}
                onChange={set('password')}
                minLength={8}
                autoComplete="new-password"
                required={!form.isBot}
              />
            )}
          </FormField>
          <FormField label="Role">
            {(id) => (
              <select id={id} value={form.role} onChange={set('role')}>
                {ROLES.map((r) => (
                  <option key={r} value={r}>
                    {ROLE_NAMES[r]}
                  </option>
                ))}
              </select>
            )}
          </FormField>
          <FormField label="Rate per hour">
            {(id) => <input id={id} type="number" min={0} step="any" value={form.hourlyRate} onChange={set('hourlyRate')} />}
          </FormField>
          <FormField label="Hours a day">
            {(id) => <input id={id} type="number" min={0} max={24} step={0.5} value={form.capacity} onChange={set('capacity')} />}
          </FormField>
          <label className="choice">
            <input type="checkbox" checked={form.isBot} onChange={set('isBot')} />
            <span>
              A bot
              <small className="field-help">An account for automation, such as triage. It shows as an agent, and never signs in with a password.</small>
            </span>
          </label>
        </div>
        <div className="cluster">
          <button type="submit" className="primary" disabled={add.isPending}>
            {add.isPending ? 'Adding…' : 'Add them'}
          </button>
          <Said text={said?.text} tone={said?.bad ? 'bad' : undefined} />
        </div>
      </fieldset>
    </form>
  );
}

function Instance({ settings }: { settings: Settings }) {
  const qc = useQueryClient();
  const [name, setName] = useState(settings.instanceName);
  const [said, setSaid] = useState<{ text: string; bad?: boolean } | null>(null);
  useEffect(() => setName(settings.instanceName), [settings.instanceName]);
  const save = useMutation({
    mutationFn: (body: { instanceName?: string; defaultTriageMode?: TriageMode }) => patch<Settings>('/settings', body),
    onSuccess: (s, body) => {
      qc.setQueryData(keys.settings, s);
      void qc.invalidateQueries({ queryKey: keys.setup });
      setSaid({ text: body.defaultTriageMode ? 'New projects start at that rung from now on.' : 'Saved.' });
    },
    onError: (e) => setSaid({ text: errorText(e), bad: true }),
  });
  return (
    <div className="stack">
      <form
        className="form-fields"
        onSubmit={(e) => {
          e.preventDefault();
          save.mutate({ instanceName: name.trim() });
        }}
      >
        <FormField label="Its name" help="Shown when people sign in.">
          {(id, help) => <input id={id} aria-describedby={help} value={name} onChange={(e) => setName(e.target.value)} required maxLength={80} />}
        </FormField>
        <FormField label="Its address" help="Links in webhooks and for agents use it. It's set by PUBLIC_URL where the server runs.">
          {(id, help) => (
            <output id={id} aria-describedby={help} className="mono">
              {settings.publicUrl}
            </output>
          )}
        </FormField>
        <div className="cluster tw:col-span-full">
          <button type="submit" disabled={name.trim() === settings.instanceName || !name.trim() || save.isPending}>
            Save the name
          </button>
        </div>
      </form>
      <LadderChoice
        legend="How far triage may go in new projects"
        rungs={TRIAGE_RUNGS}
        value={save.isPending && save.variables?.defaultTriageMode ? save.variables.defaultTriageMode : settings.defaultTriageMode}
        onChange={save.isPending ? undefined : (m) => save.mutate({ defaultTriageMode: m })}
        note="Each project can change it on its own page."
      />
      <Said text={said?.text} tone={said?.bad ? 'bad' : undefined} />
    </div>
  );
}

/** The people who use a4a, what each may do, their rate and hours, and the instance's settings. */
export default function AdminPage() {
  const users = useUsers();
  const settings = useSettings();
  const me = useMe();
  const status = useSetupStatus();
  const ways: SignInWays = { sso: status.data?.signIn.sso ?? null, passwords: status.data?.signIn.password ?? true };
  const people = users.data ?? [];
  const banned = people.filter((u) => u.banned).length;
  const bots = people.filter((u) => u.isBot).length;
  const humans = people.length - bots;
  return (
    <AdminOnly title="Administration">
      <PageHead title="Administration" about="The people who use a4a and what each may do, and this instance's settings." />
      <section className="card" aria-labelledby="people">
        <div className="section-head">
          <h2 id="people">People</h2>
          <span className="note">
            {[`${humans} ${humans === 1 ? 'person' : 'people'}`, bots ? `${bots} ${bots === 1 ? 'bot' : 'bots'}` : null, banned ? `${banned} banned` : null]
              .filter(Boolean)
              .join(', ')}
          </span>
        </div>
        <p className="note section-note">
          A rate and hours a day drive the plan: cost is time logged times the rate, and levelling books each person up to their hours. A banned person can't
          sign in, and their tokens stop working; their work stays.
        </p>
        {users.isLoading ? <Loading what="people" /> : null}
        {users.error ? <ErrorNote error={users.error} /> : null}
        {people.length ? (
          <Scroll label="Table of people">
            <table className="figures middle">
              <thead>
                <tr>
                  <th scope="col">Person</th>
                  <th scope="col">Email</th>
                  <th scope="col">Signs in with</th>
                  <th scope="col">Role</th>
                  <th scope="col">Rate per hour</th>
                  <th scope="col">Hours a day</th>
                  <th scope="col">Access</th>
                  <th scope="col">
                    <span className="hidden">Save</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {people.map((u) => (
                  <PersonRow key={u.id} user={u} isMe={u.id === me.data?.id} ways={ways} />
                ))}
              </tbody>
            </table>
          </Scroll>
        ) : null}
        <p className="note">
          Roles: {ROLES.map((r) => ROLE_WORDS[r]).join(', ')}. A token never does more than its person's role. A bot is an account for automation, such as
          triage, and shows as an agent.
        </p>
        <AddPerson />
      </section>
      <GroupsSection />
      <section className="card" aria-labelledby="vcs-people">
        <div className="section-head">
          <h2 id="vcs-people">Who wrote which commits</h2>
          <span className="note">Emails and logins at version control</span>
        </div>
        <PeopleAtProviders />
      </section>
      <section className="card" aria-labelledby="instance">
        <h2 id="instance">This instance</h2>
        {settings.isLoading ? <Loading what="settings" /> : null}
        {settings.error ? <ErrorNote error={settings.error} /> : null}
        {settings.data ? <Instance settings={settings.data} /> : null}
      </section>
    </AdminOnly>
  );
}

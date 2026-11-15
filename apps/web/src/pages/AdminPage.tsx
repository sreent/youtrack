import type { Role, Settings, TriageMode, User } from '@a4a/shared';
import { ROLES } from '@a4a/shared/constants';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { patch, post } from '../api/client';
import { keys, useMe, useSettings, useUsers } from '../api/queries';
import { ErrorNote, Loading, PageHead } from '../components/States';
import { Avatar } from '../components/Who';
import { AdminOnly, errorText, Said, Scroll } from '../features/common/bits';
import { LadderChoice } from '../features/common/Ladder';
import { TRIAGE_RUNGS } from '../features/projects/triage';
import '../features/common/pages.css';

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

function PersonRow({ user, isMe }: { user: User; isMe: boolean }) {
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
  return (
    <tr className={form.banned ? 'a4p-archived' : undefined}>
      <th scope="row">
        <span className="a4p-person">
          <Avatar kind={user.isBot ? 'agent' : 'person'} name={user.name} small />
          <span>
            <input value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} aria-label={label('Name')} maxLength={100} required />
            <span className="a4p-row-about">
              <span className="a4p-mono">{user.login}</span>
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
        />
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
          className="a4p-num-input"
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
          className="a4p-num-input"
        />
      </td>
      <td>
        <label className="a4p-check">
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
      <td className="a4p-tight">
        <button type="button" className="a4p-small" disabled={!dirty || !form.name.trim() || save.isPending} onClick={() => save.mutate()}>
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
      onSubmit={(e) => {
        e.preventDefault();
        add.mutate();
      }}
    >
      <fieldset className="link-add">
        <legend>Add someone</legend>
        <div className="a4p-fields">
          <label className="a4p-field">
            <span>Name</span>
            <input value={form.name} onChange={set('name')} required maxLength={100} />
          </label>
          <label className="a4p-field">
            <span>Login</span>
            <input
              value={form.login}
              onChange={set('login')}
              required
              minLength={2}
              maxLength={40}
              pattern="[a-zA-Z0-9._\-]+"
              className="a4p-mono-input"
              autoComplete="off"
            />
          </label>
          <label className="a4p-field">
            <span>Email</span>
            <input type="email" value={form.email} onChange={set('email')} />
          </label>
          <label className="a4p-field">
            <span>Password</span>
            <input type="password" value={form.password} onChange={set('password')} minLength={8} autoComplete="new-password" required={!form.isBot} />
            <small>{form.isBot ? "A bot doesn't sign in with a password." : 'At least 8 characters. They can change it on their profile.'}</small>
          </label>
          <label className="a4p-field">
            <span>Role</span>
            <select value={form.role} onChange={set('role')}>
              {ROLES.map((r) => (
                <option key={r} value={r}>
                  {ROLE_NAMES[r]}
                </option>
              ))}
            </select>
          </label>
          <label className="a4p-field">
            <span>Rate per hour</span>
            <input type="number" min={0} step="any" value={form.hourlyRate} onChange={set('hourlyRate')} />
          </label>
          <label className="a4p-field">
            <span>Hours a day</span>
            <input type="number" min={0} max={24} step={0.5} value={form.capacity} onChange={set('capacity')} />
          </label>
          <label className="a4p-check a4p-check-low">
            <input type="checkbox" checked={form.isBot} onChange={set('isBot')} />
            <span>
              A bot
              <small>An account for automation, such as triage. It shows as an agent, and never signs in with a password.</small>
            </span>
          </label>
        </div>
        <div className="a4p-actions">
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
    <div className="a4p-form">
      <form
        className="a4p-fields"
        onSubmit={(e) => {
          e.preventDefault();
          save.mutate({ instanceName: name.trim() });
        }}
      >
        <label className="a4p-field">
          <span>Its name</span>
          <input value={name} onChange={(e) => setName(e.target.value)} required maxLength={80} />
          <small>Shown when people sign in.</small>
        </label>
        <div className="a4p-field">
          <span>Its address</span>
          <span className="a4p-mono">{settings.publicUrl}</span>
          <small>Links in webhooks and for agents use it. It's set by PUBLIC_URL where the server runs.</small>
        </div>
        <div className="a4p-actions a4p-wide">
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
  const people = users.data ?? [];
  const banned = people.filter((u) => u.banned).length;
  const bots = people.filter((u) => u.isBot).length;
  const humans = people.length - bots;
  return (
    <AdminOnly title="Administration">
      <PageHead title="Administration" about="The people who use a4a and what each may do, and this instance's settings." />
      <section className="card" aria-labelledby="people">
        <div className="a4p-section-head">
          <h2 id="people">People</h2>
          <span className="note">
            {[`${humans} ${humans === 1 ? 'person' : 'people'}`, bots ? `${bots} ${bots === 1 ? 'bot' : 'bots'}` : null, banned ? `${banned} banned` : null]
              .filter(Boolean)
              .join(', ')}
          </span>
        </div>
        <p className="note a4p-lead">
          A rate and hours a day drive the plan: cost is time logged times the rate, and levelling books each person up to their hours. A banned person can't
          sign in, and their tokens stop working; their work stays.
        </p>
        {users.isLoading ? <Loading what="people" /> : null}
        {users.error ? <ErrorNote error={users.error} /> : null}
        {people.length ? (
          <Scroll label="Table of people">
            <table className="figures a4p-people">
              <thead>
                <tr>
                  <th scope="col">Person</th>
                  <th scope="col">Email</th>
                  <th scope="col">Role</th>
                  <th scope="col">Rate per hour</th>
                  <th scope="col">Hours a day</th>
                  <th scope="col">Access</th>
                  <th scope="col">
                    <span className="a4-sr-only">Save</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {people.map((u) => (
                  <PersonRow key={u.id} user={u} isMe={u.id === me.data?.id} />
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
      <section className="card" aria-labelledby="instance">
        <h2 id="instance">This instance</h2>
        {settings.isLoading ? <Loading what="settings" /> : null}
        {settings.error ? <ErrorNote error={settings.error} /> : null}
        {settings.data ? <Instance settings={settings.data} /> : null}
      </section>
    </AdminOnly>
  );
}

import type { Me } from '@a4a/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router';
import { patch } from '../api/client';
import { keys, useMe, useSetupStatus } from '../api/queries';
import { ErrorLine, Loading, PageHead } from '../components/States';
import { Avatar } from '../components/Who';
import { errorText, FormField, Said } from '../features/common/bits';
import { DaysAway } from '../features/away/DaysAway';
import { WorkWeek } from '../features/away/WorkWeek';
import { EmailSettings } from '../features/notifications/EmailSettings';
import { SubscriptionList } from '../features/notifications/Subscriptions';
import { emailKeys, YourEmails } from '../features/vcs/People';
import { CodeHostAccounts } from '../features/builds/Builds';
import { TwoFactorCard } from '../features/identity/TwoFactor';
import { ChatAccounts } from '../features/chat/Chat';

const ROLE_WORDS: Record<Me['role'], string> = {
  admin: 'an administrator: you may change everything',
  member: 'a member: you read and change issues',
  viewer: 'a viewer: you read',
};

/** Every time zone the browser knows, with the browser's own and the one already chosen among them. */
function zoneNames(...also: (string | null)[]): string[] {
  const known = (Intl as unknown as { supportedValuesOf?: (key: string) => string[] }).supportedValuesOf?.('timeZone') ?? [];
  return [...new Set([...known, ...also.filter((z): z is string => Boolean(z))])].sort();
}

function browserZone(): string | null {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || null;
  } catch {
    return null;
  }
}

function You({ me }: { me: Me }) {
  const qc = useQueryClient();
  const [name, setName] = useState(me.name);
  const [email, setEmail] = useState(me.email ?? '');
  const [zone, setZone] = useState(me.timeZone ?? '');
  const [said, setSaid] = useState<{ text: string; bad?: boolean } | null>(null);
  useEffect(() => {
    setName(me.name);
    setEmail(me.email ?? '');
    setZone(me.timeZone ?? '');
  }, [me.name, me.email, me.timeZone]);
  const browser = useMemo(browserZone, []);
  const zones = useMemo(() => zoneNames(browser, me.timeZone, me.serverTimeZone), [browser, me.timeZone, me.serverTimeZone]);
  const dirty = name !== me.name || email !== (me.email ?? '') || zone !== (me.timeZone ?? '');
  const save = useMutation({
    mutationFn: () => patch<Me>('/me', { name: name.trim(), email: email.trim() || null, timeZone: zone || null }),
    onSuccess: (m) => {
      qc.setQueryData(keys.me, m);
      void qc.invalidateQueries({ queryKey: keys.users });
      // Searches and email settings read dates where you are: ask again.
      void qc.invalidateQueries({ queryKey: ['notifications', 'settings'] });
      void qc.invalidateQueries({ queryKey: emailKeys.mine });
      setSaid({ text: m.name !== me.name ? 'Saved. People see your new name from now on.' : 'Saved.' });
    },
    onError: (e) => setSaid({ text: errorText(e), bad: true }),
  });
  return (
    <form
      className="form"
      onSubmit={(e) => {
        e.preventDefault();
        save.mutate();
      }}
    >
      <div className="form-fields">
        <FormField label="Name">
          {(id) => <input id={id} value={name} onChange={(e) => setName(e.target.value)} required maxLength={100} autoComplete="name" />}
        </FormField>
        <FormField label="Email" help="Your primary email, where a4a writes. Confirm it, and add others, under Emails.">
          {(id, help) => <input id={id} aria-describedby={help} type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" />}
        </FormField>
        <FormField
          label="Time zone"
          help={
            <>
              What “today” means in your searches, when your digest comes, and the times in your email.
              {browser && browser !== (zone || me.serverTimeZone) ? (
                <>
                  {' '}
                  <button type="button" className="link" onClick={() => setZone(browser)}>
                    Use your browser’s, {browser.replaceAll('_', ' ')}
                  </button>
                </>
              ) : null}
            </>
          }
        >
          {(id, help) => (
            <select id={id} aria-describedby={help} value={zone} onChange={(e) => setZone(e.target.value)}>
              <option value="">The server’s ({me.serverTimeZone.replaceAll('_', ' ')})</option>
              {zones.map((z) => (
                <option key={z} value={z}>
                  {z.replaceAll('_', ' ')}
                </option>
              ))}
            </select>
          )}
        </FormField>
      </div>
      <div className="cluster">
        <button type="submit" className="primary" disabled={!dirty || !name.trim() || save.isPending}>
          {save.isPending ? 'Saving…' : 'Save the changes'}
        </button>
        <Said text={said?.text} tone={said?.bad ? 'bad' : undefined} />
      </div>
    </form>
  );
}

function Password({ me }: { me: Me }) {
  const qc = useQueryClient();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [again, setAgain] = useState('');
  const [said, setSaid] = useState<{ text: string; bad?: boolean } | null>(null);
  const [changed, setChanged] = useState(false);
  const change = useMutation({
    mutationFn: () => patch<Me>('/me', { password: next, currentPassword: current }),
    onSuccess: () => {
      setCurrent('');
      setNext('');
      setAgain('');
      setChanged(true);
      setSaid({ text: 'Your password is changed, and every session is signed out, this one too.' });
    },
    onError: (e) => setSaid({ text: errorText(e), bad: true }),
  });
  const mismatch = again.length > 0 && again !== next;
  return (
    <form
      className="form"
      onSubmit={(e) => {
        e.preventDefault();
        if (next !== again) {
          setSaid({ text: "The new passwords aren't the same. Type it again.", bad: true });
          return;
        }
        change.mutate();
      }}
    >
      <input type="text" name="username" autoComplete="username" value={me.login} readOnly hidden />
      <div className="form-fields">
        <FormField label="Current password">
          {(id) => <input id={id} type="password" value={current} onChange={(e) => setCurrent(e.target.value)} required autoComplete="current-password" />}
        </FormField>
        <FormField label="New password" help="At least 8 characters.">
          {(id, help) => (
            <input
              id={id}
              type="password"
              value={next}
              onChange={(e) => setNext(e.target.value)}
              required
              minLength={8}
              autoComplete="new-password"
              aria-describedby={help}
            />
          )}
        </FormField>
        <FormField label="The new one again">
          {(id) => (
            <>
              <input
                id={id}
                type="password"
                value={again}
                onChange={(e) => setAgain(e.target.value)}
                required
                minLength={8}
                autoComplete="new-password"
                aria-invalid={mismatch || undefined}
                aria-describedby={mismatch ? 'pw-mismatch' : undefined}
              />
              {mismatch ? <ErrorLine id="pw-mismatch">Not the same as the new password.</ErrorLine> : null}
            </>
          )}
        </FormField>
      </div>
      <div className="cluster">
        {changed ? (
          <Link className="button" to="/login" onClick={() => qc.clear()}>
            Sign in again
          </Link>
        ) : (
          <button type="submit" disabled={!current || next.length < 8 || mismatch || change.isPending}>
            {change.isPending ? 'Changing…' : 'Change the password'}
          </button>
        )}
        <Said text={said?.text} tone={said?.bad ? 'bad' : undefined} />
      </div>
    </form>
  );
}

/** How a4a names you, and how you sign in. */
export default function ProfilePage() {
  const me = useMe();
  const status = useSetupStatus();
  if (!me.data) return <Loading what="your profile" />;
  const m = me.data;
  const sso = status.data?.signIn.sso ?? status.data?.signIn.saml ?? null;
  const passwords = status.data?.signIn.password ?? true;
  const ldap = status.data?.signIn.ldap ?? null;
  // A code after the password, for whoever signs in with one: a4a's or the directory's (D38).
  const signsInWithPassword = !m.isBot && ((passwords && m.signIn?.password !== false) || Boolean(ldap));
  return (
    <>
      <PageHead
        title="Your profile"
        about="How a4a names you to others, and how you sign in."
        meta={
          <>
            <span className="tw:inline-flex tw:items-center tw:gap-2">
              <Avatar kind="person" name={m.name} small /> <span className="mono">{m.login}</span>
            </span>
            <span>You're {ROLE_WORDS[m.role]}.</span>
          </>
        }
      />
      <section className="card" aria-labelledby="you">
        <h2 id="you">You</h2>
        <You me={m} />
      </section>
      <section className="card" aria-labelledby="emails">
        <div className="section-head">
          <h2 id="emails">Emails</h2>
          <span className="note">Whose commits are yours</span>
        </div>
        <YourEmails />
      </section>
      <CodeHostAccounts />
      <section className="card" aria-labelledby="notifications">
        <h2 id="notifications">Notifications</h2>
        <EmailSettings />
      </section>
      <section className="card" aria-labelledby="away">
        <div className="section-head">
          <h2 id="away">Days away</h2>
          <span className="note">Plans skip them for your work</span>
        </div>
        <p className="section-note">Everyone sees when you're away; why, only you, administrators and whoever enters it.</p>
        <DaysAway person={{ login: m.login, name: m.name }} you canEnter={m.auth.scopes.includes('write') && !m.isBot} />
      </section>

      <section className="card" aria-labelledby="week">
        <div className="section-head">
          <h2 id="week">Working week</h2>
          <span className="note">Your hours each day</span>
        </div>
        <p className="section-note">Part time, or a weekday off: plans give you work on the days you work, those hours each, and your timesheet measures each day against them.</p>
        <WorkWeek week={m.workWeek} capacity={m.capacityHoursPerDay} canChange={m.auth.scopes.includes('write') && !m.isBot} />
      </section>

      <section className="card" aria-labelledby="subscriptions">
        <div className="section-head">
          <h2 id="subscriptions">What you subscribe to</h2>
          <span className="note">Projects and saved searches you asked to hear of.</span>
        </div>
        <SubscriptionList />
      </section>
      <section className="card" aria-labelledby="password">
        <h2 id="password">{passwords ? 'Password' : 'Signing in'}</h2>
        {passwords ? <Password me={m} /> : <p className="note">You sign in with {sso?.name ?? 'single sign-on'}. Passwords aren’t used here.</p>}
        {passwords && sso ? <p className="note">You can also sign in with {sso.name}, with the email {sso.name} has for you.</p> : null}
      </section>
      {signsInWithPassword ? (
        <section className="card" aria-labelledby="two-factor">
          <div className="section-head">
            <h2 id="two-factor">Two-factor sign-in</h2>
            <span className="note">A code from your phone after your password</span>
          </div>
          <TwoFactorCard />
        </section>
      ) : null}
      <section className="card" aria-labelledby="chat-accounts">
        <div className="section-head">
          <h2 id="chat-accounts">Chat accounts</h2>
          <span className="note">Teams and Slack accounts that act as you</span>
        </div>
        <ChatAccounts />
      </section>
      <section className="card" aria-labelledby="agents">
        <h2 id="agents">Tokens for agents and scripts</h2>
        <p className="note">
          An agent or a script acts as you with a token of its own, which you can revoke at any time. They're on <Link to="/agents">Agents and tokens</Link>.
        </p>
      </section>
    </>
  );
}

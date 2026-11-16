import type { Me } from '@a4a/shared';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { Navigate, useLocation, useNavigate, useSearchParams } from 'react-router';
import { ApiError, post } from '../api/client';
import { keys, useMe, useSetupStatus } from '../api/queries';
import { ErrorNote, Loading } from '../components/States';
import { Icon } from '../components/Icon';
import { Shell } from './Shell';
import { FormField } from '../components/Form';

/** A page before the frame (Ocean's lone page): one card in the middle; `wide` for a conversation, as a help desk's. */
export function Lone({ children, wide }: { children: React.ReactNode; wide?: boolean }) {
  useEffect(() => {
    document.body.classList.add('lone');
    return () => document.body.classList.remove('lone');
  }, []);
  return <main className={wide ? 'card lone-card wide stack' : 'card lone-card stack'}>{children}</main>;
}

/** Signed-in pages: the frame, or the way to sign in / set up. */
export function RequireUser() {
  const setup = useSetupStatus();
  const me = useMe();
  const location = useLocation();
  if (setup.isLoading || me.isLoading) {
    return (
      <Lone>
        <Loading />
      </Lone>
    );
  }
  if (setup.data?.needsSetup) return <Navigate to="/setup" replace />;
  if (me.error instanceof ApiError && me.error.status === 401) {
    // Back where they were after signing in, whichever way they sign in.
    const here = `${location.pathname}${location.search}`;
    return <Navigate to={here === '/' || here === '/issues' ? '/login' : `/login?next=${encodeURIComponent(here)}`} replace />;
  }
  if (me.error || !me.data) {
    return (
      <Lone>
        <ErrorNote error={me.error} />
      </Lone>
    );
  }
  return <Shell me={me.data} />;
}

function AuthCard({ title, about, children }: { title: string; about: string; children: React.ReactNode }) {
  return (
    <Lone>
      <span className="brand">
        <span className="mark">a4</span>
        <span>a4a</span>
      </span>
      <h1>{title}</h1>
      <p className="note">{about}</p>
      {children}
    </Lone>
  );
}

/** Why single sign-on sent someone back here (the callback's ?sso=), and what to do about it. */
function ssoFailure(code: string, name: string): { what: string; fix: string } {
  switch (code) {
    case 'cancelled':
      return { what: `Signing in with ${name} was cancelled.`, fix: 'Sign in again when you’re ready.' };
    case 'expired':
      return { what: 'That sign-in ran out of time, or was started in another tab or browser.', fix: 'Start again here.' };
    case 'unverified':
      return { what: `${name} hasn’t verified your email.`, fix: `Verify it with ${name}, then sign in again.` };
    case 'domain':
      return { what: 'Accounts with your email’s domain can’t sign in here.', fix: 'Sign in with your work account, or ask an administrator.' };
    case 'no_account':
      return { what: 'There’s no a4a account for your email yet.', fix: 'Ask an administrator to add you.' };
    case 'unconfirmed':
      return {
        what: 'An a4a account has your email, but no administrator has confirmed it.',
        fix: 'Ask an administrator to confirm your email under Administration, then sign in again.',
      };
    case 'ambiguous':
      return { what: 'More than one a4a account has your email.', fix: 'Ask an administrator to sort it out.' };
    case 'refused':
      return { what: `This account can’t sign in with ${name}.`, fix: 'Ask an administrator.' };
    case 'unlinked':
      return {
        what: `An a4a account already has your email, and a4a doesn’t take emails from ${name} as proof that it’s yours.`,
        fix: `Ask an administrator: they can have a4a trust the emails ${name} gives.`,
      };
    default:
      return { what: `${name} didn’t sign you in.`, fix: 'Try again. If it keeps failing, tell an administrator: the server’s log says why.' };
  }
}

export function LoginPage() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const status = useSetupStatus();
  const [login, setLogin] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const raw = params.get('next') ?? '';
  const next = raw.startsWith('/') && !raw.startsWith('//') ? raw : '/issues';
  // OpenID Connect, SAML, or both (D16, D27).
  const providers = [status.data?.signIn.sso, status.data?.signIn.saml].filter((p): p is { name: string; url: string } => Boolean(p));
  const sso = providers.length ? { name: providers.map((p) => p.name).join(' or ') } : null;
  const passwords = status.data?.signIn.password ?? true;
  const failed = params.get('sso');
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const me = await post<Me>('/auth/login', { login, password });
      qc.setQueryData(keys.me, me);
      navigate(next);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };
  const failure = failed && sso ? ssoFailure(failed, providers.length === 1 ? providers[0]!.name : 'your identity provider') : null;
  return (
    <AuthCard title="Sign in" about={sso && !passwords ? `Use your ${sso.name} account.` : sso ? `Use your ${sso.name} account, or your a4a login.` : 'Use your a4a login.'}>
      {failure ? (
        <div className="error-note" role="alert">
          <Icon name="cross" />
          <strong>{failure.what}</strong>
          <p>{failure.fix}</p>
        </div>
      ) : null}
      {providers.map((p) => (
        <a key={p.url} className={passwords ? 'button' : 'button primary'} href={`${p.url}?next=${encodeURIComponent(next)}`}>
          Sign in with {p.name}
        </a>
      ))}
      {passwords ? (
        <form className="form" onSubmit={submit} aria-label={sso ? 'Sign in with your a4a login' : undefined}>
          <FormField label="Login">{(id) => <input id={id} value={login} onChange={(e) => setLogin(e.target.value)} autoComplete="username" required autoFocus={!sso} />}</FormField>
          <FormField label="Password">
            {(id) => <input id={id} type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" required />}
          </FormField>
          {error ? <ErrorNote error={error} /> : null}
          <button type="submit" className="primary" disabled={busy}>
            {busy ? 'Signing in…' : 'Sign in'}
          </button>
        </form>
      ) : null}
    </AuthCard>
  );
}

export function SetupPage() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const status = useSetupStatus();
  const [form, setForm] = useState({ login: 'admin', name: '', email: '', password: '', seedDemo: true });
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  if (status.data && !status.data.needsSetup) return <Navigate to="/login" replace />;
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const me = await post<Me>('/auth/setup', { ...form, email: form.email || undefined });
      qc.setQueryData(keys.me, me);
      await qc.invalidateQueries({ queryKey: keys.setup });
      navigate('/issues');
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };
  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setForm((f) => ({ ...f, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value }));
  return (
    <AuthCard title="Set up a4a" about="Create the first administrator. You can invite everyone else afterwards.">
      <form className="form" onSubmit={submit}>
        <FormField label="Your name">{(id) => <input id={id} value={form.name} onChange={set('name')} required autoFocus />}</FormField>
        <FormField label="Login">{(id) => <input id={id} value={form.login} onChange={set('login')} required pattern="[a-zA-Z0-9._\-]+" />}</FormField>
        {status.data?.signIn.password === false ? (
          <FormField label={`Email (you'll sign in with ${status.data.signIn.sso?.name ?? status.data.signIn.saml?.name ?? 'single sign-on'}, which finds you by it)`}>
            {(id) => <input id={id} type="email" value={form.email} onChange={set('email')} required autoComplete="email" />}
          </FormField>
        ) : (
          <FormField label="Email (optional)">{(id) => <input id={id} type="email" value={form.email} onChange={set('email')} />}</FormField>
        )}
        <FormField label="Password (at least 8 characters)">
          {(id) => <input id={id} type="password" value={form.password} onChange={set('password')} minLength={8} required autoComplete="new-password" />}
        </FormField>
        <label className="choice">
          <input type="checkbox" checked={form.seedDemo} onChange={set('seedDemo')} />
          <span>Add demo projects, so you can try everything at once</span>
        </label>
        {error ? <ErrorNote error={error} /> : null}
        <button type="submit" className="primary" disabled={busy}>
          {busy ? 'Setting up…' : 'Create the administrator'}
        </button>
      </form>
    </AuthCard>
  );
}

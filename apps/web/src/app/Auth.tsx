import type { Me } from '@a4a/shared';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { Navigate, useNavigate } from 'react-router';
import { ApiError, post } from '../api/client';
import { keys, useMe, useSetupStatus } from '../api/queries';
import { ErrorNote, Loading } from '../components/States';
import { Shell } from './Shell';
import { FormField } from '../components/Form';

/** A page before the frame (Ocean's lone page): one card in the middle. */
function Lone({ children }: { children: React.ReactNode }) {
  useEffect(() => {
    document.body.classList.add('lone');
    return () => document.body.classList.remove('lone');
  }, []);
  return <main className="card lone-card stack">{children}</main>;
}

/** Signed-in pages: the frame, or the way to sign in / set up. */
export function RequireUser() {
  const setup = useSetupStatus();
  const me = useMe();
  if (setup.isLoading || me.isLoading) {
    return (
      <Lone>
        <Loading />
      </Lone>
    );
  }
  if (setup.data?.needsSetup) return <Navigate to="/setup" replace />;
  if (me.error instanceof ApiError && me.error.status === 401) return <Navigate to="/login" replace />;
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

export function LoginPage() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [login, setLogin] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const me = await post<Me>('/auth/login', { login, password });
      qc.setQueryData(keys.me, me);
      navigate('/issues');
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };
  return (
    <AuthCard title="Sign in" about="Use your a4a login.">
      <form className="form" onSubmit={submit}>
        <FormField label="Login">{(id) => <input id={id} value={login} onChange={(e) => setLogin(e.target.value)} autoComplete="username" required autoFocus />}</FormField>
        <FormField label="Password">
          {(id) => <input id={id} type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" required />}
        </FormField>
        {error ? <ErrorNote error={error} /> : null}
        <button type="submit" className="primary" disabled={busy}>
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
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
        <FormField label="Email (optional)">{(id) => <input id={id} type="email" value={form.email} onChange={set('email')} />}</FormField>
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

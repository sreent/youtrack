import type { Me } from '@a4a/shared';
import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Navigate, useNavigate } from 'react-router';
import { ApiError, post } from '../api/client';
import { keys, useMe, useSetupStatus } from '../api/queries';
import { ErrorNote, Loading } from '../components/States';
import { Shell } from './Shell';

/** Signed-in pages: the frame, or the way to sign in / set up. */
export function RequireUser() {
  const setup = useSetupStatus();
  const me = useMe();
  if (setup.isLoading || me.isLoading) {
    return (
      <div className="a4-center">
        <Loading />
      </div>
    );
  }
  if (setup.data?.needsSetup) return <Navigate to="/setup" replace />;
  if (me.error instanceof ApiError && me.error.status === 401) return <Navigate to="/login" replace />;
  if (me.error || !me.data) {
    return (
      <div className="a4-center">
        <ErrorNote error={me.error} />
      </div>
    );
  }
  return <Shell me={me.data} />;
}

function AuthCard({ title, about, children }: { title: string; about: string; children: React.ReactNode }) {
  return (
    <div className="a4-center">
      <section className="card a4-auth">
        <div className="a4-row">
          <span className="brand">
            <span className="mark">a4</span>
            <span>a4a</span>
          </span>
        </div>
        <h1>{title}</h1>
        <p className="note">{about}</p>
        {children}
      </section>
    </div>
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
      <form className="a4-form" onSubmit={submit}>
        <label>
          Login
          <input value={login} onChange={(e) => setLogin(e.target.value)} autoComplete="username" required autoFocus />
        </label>
        <label>
          Password
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" required />
        </label>
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
      <form className="a4-form" onSubmit={submit}>
        <label>
          Your name
          <input value={form.name} onChange={set('name')} required autoFocus />
        </label>
        <label>
          Login
          <input value={form.login} onChange={set('login')} required pattern="[a-zA-Z0-9._\-]+" />
        </label>
        <label>
          Email (optional)
          <input type="email" value={form.email} onChange={set('email')} />
        </label>
        <label>
          Password (at least 8 characters)
          <input type="password" value={form.password} onChange={set('password')} minLength={8} required autoComplete="new-password" />
        </label>
        <label className="a4-row">
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

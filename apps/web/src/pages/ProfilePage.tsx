import type { Me } from '@a4a/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import { patch } from '../api/client';
import { keys, useMe } from '../api/queries';
import { Loading, PageHead } from '../components/States';
import { Avatar } from '../components/Who';
import { errorText, Said } from '../features/common/bits';
import '../features/common/pages.css';

const ROLE_WORDS: Record<Me['role'], string> = {
  admin: 'an administrator: you may change everything',
  member: 'a member: you read and change issues',
  viewer: 'a viewer: you read',
};

function You({ me }: { me: Me }) {
  const qc = useQueryClient();
  const [name, setName] = useState(me.name);
  const [email, setEmail] = useState(me.email ?? '');
  const [said, setSaid] = useState<{ text: string; bad?: boolean } | null>(null);
  useEffect(() => {
    setName(me.name);
    setEmail(me.email ?? '');
  }, [me.name, me.email]);
  const dirty = name !== me.name || email !== (me.email ?? '');
  const save = useMutation({
    mutationFn: () => patch<Me>('/me', { name: name.trim(), email: email.trim() || null }),
    onSuccess: (m) => {
      qc.setQueryData(keys.me, m);
      void qc.invalidateQueries({ queryKey: keys.users });
      setSaid({ text: 'Saved. People see your new name from now on.' });
    },
    onError: (e) => setSaid({ text: errorText(e), bad: true }),
  });
  return (
    <form
      className="a4p-form"
      onSubmit={(e) => {
        e.preventDefault();
        save.mutate();
      }}
    >
      <div className="a4p-fields">
        <label className="a4p-field">
          <span>Name</span>
          <input value={name} onChange={(e) => setName(e.target.value)} required maxLength={100} autoComplete="name" />
        </label>
        <label className="a4p-field">
          <span>Email</span>
          <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" />
          <small>Optional.</small>
        </label>
      </div>
      <div className="a4p-actions">
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
      className="a4p-form"
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
      <div className="a4p-fields">
        <label className="a4p-field">
          <span>Current password</span>
          <input type="password" value={current} onChange={(e) => setCurrent(e.target.value)} required autoComplete="current-password" />
        </label>
        <label className="a4p-field">
          <span>New password</span>
          <input
            type="password"
            value={next}
            onChange={(e) => setNext(e.target.value)}
            required
            minLength={8}
            autoComplete="new-password"
            aria-describedby="pw-help"
          />
          <small id="pw-help">At least 8 characters.</small>
        </label>
        <label className="a4p-field">
          <span>The new one again</span>
          <input
            type="password"
            value={again}
            onChange={(e) => setAgain(e.target.value)}
            required
            minLength={8}
            autoComplete="new-password"
            aria-invalid={mismatch || undefined}
            aria-describedby={mismatch ? 'pw-mismatch' : undefined}
          />
          {mismatch ? (
            <small id="pw-mismatch" className="a4p-said-bad">
              Not the same as the new password.
            </small>
          ) : null}
        </label>
      </div>
      <div className="a4p-actions">
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
  if (!me.data) return <Loading what="your profile" />;
  const m = me.data;
  return (
    <>
      <PageHead
        title="Your profile"
        about="How a4a names you to others, and how you sign in."
        meta={
          <>
            <span className="a4p-meta-who">
              <Avatar kind="person" name={m.name} small /> <span className="a4p-mono">{m.login}</span>
            </span>
            <span>You're {ROLE_WORDS[m.role]}.</span>
          </>
        }
      />
      <section className="card" aria-labelledby="you">
        <h2 id="you">You</h2>
        <You me={m} />
      </section>
      <section className="card" aria-labelledby="password">
        <h2 id="password">Password</h2>
        <Password me={m} />
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

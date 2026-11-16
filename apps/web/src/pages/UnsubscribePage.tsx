import type { Unsubscribe } from '@a4a/shared';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { ApiError, get, post, qs } from '../api/client';
import { Lone } from '../app/Auth';
import { ErrorNote, Loading } from '../components/States';

/**
 * Where an email's "Stop emails like this" leads. Opening it changes nothing (mail scanners open
 * links); the button does, as a mail client's one-click unsubscribe does.
 */
export default function UnsubscribePage() {
  const [params] = useSearchParams();
  const token = params.get('token') ?? '';
  const described = useQuery({ queryKey: ['unsubscribe', token], queryFn: () => get<Unsubscribe>(`/unsubscribe${qs({ token })}`), enabled: Boolean(token), retry: false });
  const [done, setDone] = useState<Unsubscribe | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  if (!token || described.error) {
    const missing = !token || (described.error instanceof ApiError && described.error.status === 404);
    return (
      <Lone>
        <h1>{missing ? "This link doesn't stop anything" : "This page didn't load"}</h1>
        {missing ? <p className="note">It may have been copied only in part. If you can sign in, choose what a4a emails you on your profile.</p> : <ErrorNote error={described.error} />}
      </Lone>
    );
  }
  if (described.isLoading || !described.data) {
    return (
      <Lone>
        <Loading />
      </Lone>
    );
  }
  const d = done ?? described.data;
  const stop = async () => {
    setBusy(true);
    setError(null);
    try {
      setDone(await post<Unsubscribe>(`/unsubscribe${qs({ token })}`));
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Lone>
      <h1>{d.done ? 'Stopped' : 'Stop these emails?'}</h1>
      <p>{d.done ? `No more of these: ${d.what.charAt(0).toLowerCase()}${d.what.slice(1)}` : d.what}</p>
      {error ? <ErrorNote error={error} /> : null}
      {d.done ? (
        d.kind === 'request' ? (
          <p className="note">Your request's page still works, from the link in any email about it.</p>
        ) : (
          <p className="note">
            Changed your mind? Choose what a4a emails you on <Link to="/me">your profile</Link>.
          </p>
        )
      ) : (
        <div className="cluster">
          <button type="button" className="primary" onClick={() => void stop()} disabled={busy}>
            {busy ? 'Stopping…' : 'Stop them'}
          </button>
        </div>
      )}
    </Lone>
  );
}

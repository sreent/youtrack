import type { Unsubscribe } from '@a4a/shared';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { ApiError, get, post, qs } from '../api/client';
import { Lone } from '../app/Auth';
import { ErrorNote, Loading } from '../components/States';
import { t, tr, inSentence } from '../i18n';
import type { ReactNode } from 'react';

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
        <h1>{missing ? t('page.unsubscribe.thisLinkDoesnTStop') : t('page.unsubscribe.thisPageDidnTLoad')}</h1>
        {missing ? <p className="note">{t('page.unsubscribe.itMayHaveBeenCopied')}</p> : <ErrorNote error={described.error} />}
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
      <h1>{d.done ? t('page.unsubscribe.stopped') : t('page.unsubscribe.stopTheseEmails')}</h1>
      <p>{d.done ? t('page.unsubscribe.noMoreOfThese', { what: inSentence(d.what) }) : d.what}</p>
      {error ? <ErrorNote error={error} /> : null}
      {d.done ? (
        d.kind === 'request' ? (
          <p className="note">{t('page.unsubscribe.yourRequestSPageStill')}</p>
        ) : (
          <p className="note">{tr('page.unsubscribe.changedYourMindChooseWhat', { t0: (c: ReactNode) => <Link to="/me">{c}</Link> })}</p>
        )
      ) : (
        <div className="cluster">
          <button type="button" className="primary" onClick={() => void stop()} disabled={busy}>
            {busy ? t('page.unsubscribe.stopping') : t('page.unsubscribe.stopThem')}
          </button>
        </div>
      )}
    </Lone>
  );
}

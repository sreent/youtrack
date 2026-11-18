import type { PasskeyAlert } from '@a4a/shared';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { ApiError, get, post, qs } from '../api/client';
import { Lone } from '../app/Auth';
import { agoSaid } from '../components/Badges';
import { ErrorNote, Loading } from '../components/States';
import { t } from '../i18n';

const HEADS: Record<PasskeyAlert['change'], string> = {
  'password-removed': 'page.notMe.passwordRemoved',
  added: 'page.notMe.added',
  removed: 'page.notMe.removed',
  copied: 'page.notMe.copied',
};

/**
 * Where a mail's "This wasn't me" leads (D62). Opening it changes nothing (mail scanners open links);
 * the button signs its person out everywhere and stops the passkey. It needs no sign-in: it only takes
 * access away.
 */
export default function NotMePage() {
  const [params] = useSearchParams();
  const token = params.get('token') ?? '';
  const described = useQuery({ queryKey: ['not-me', token], queryFn: () => get<PasskeyAlert>(`/not-me${qs({ token })}`), enabled: Boolean(token), retry: false });
  const [done, setDone] = useState<PasskeyAlert | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  if (!token || described.error) {
    const missing = !token || (described.error instanceof ApiError && described.error.status === 404);
    return (
      <Lone>
        <h1>{missing ? t('page.notMe.gone') : t('page.notMe.didntLoad')}</h1>
        {missing ? <p className="note">{t('page.notMe.goneAbout')}</p> : <ErrorNote error={described.error} />}
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
  // A password removed (D68) names no passkey, and leaves none to fall back on.
  const password = d.change === 'password-removed';
  const follow = async () => {
    setBusy(true);
    setError(null);
    try {
      setDone(await post<PasskeyAlert>(`/not-me${qs({ token })}`));
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Lone>
      <h1>{d.done ? t('page.notMe.done') : t(HEADS[d.change])}</h1>
      <p>{password ? t('page.notMe.whatPassword', { login: d.login, date: agoSaid(d.changedAt) }) : t('page.notMe.what', { name: d.name, login: d.login, date: agoSaid(d.changedAt) })}</p>
      {error ? <ErrorNote error={error} /> : null}
      {d.done ? (
        <>
          <p role="status">{password ? t('page.notMe.doneAboutPassword') : t('page.notMe.doneAbout', { change: d.change, name: d.name })}</p>
          <p className="note">{password ? t('page.notMe.nextNoPassword') : t('page.notMe.next')}</p>
          <div className="cluster">
            <Link className="button primary" to="/login">
              {t('page.notMe.signIn')}
            </Link>
          </div>
        </>
      ) : (
        <>
          <p className="note">{password ? t('page.notMe.ifNotYouPassword') : t('page.notMe.ifNotYou', { change: d.change })}</p>
          <div className="cluster">
            <button type="button" className="danger" onClick={() => void follow()} disabled={busy}>
              {busy ? t('page.notMe.signingOut') : t('page.notMe.signMeOut')}
            </button>
          </div>
        </>
      )}
    </Lone>
  );
}

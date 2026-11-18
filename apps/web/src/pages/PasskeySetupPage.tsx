import type { Me, PasskeyOptions, PasskeySetupInfo } from '@a4a/shared';
import { browserSupportsWebAuthn, startRegistration } from '@simplewebauthn/browser';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router';
import { ApiError, post } from '../api/client';
import { keys } from '../api/queries';
import { Lone } from '../app/Auth';
import { untilSaid } from '../components/Badges';
import { ErrorNote, Loading } from '../components/States';
import { passkeyCancelled } from '../features/identity/Passkeys';
import { t } from '../i18n';

/**
 * Where an administrator's link leads (D68): it adds the first passkey to an account with no
 * password, or one in place of those it lost, and signs its person in. The token is the link's
 * fragment, which no server's log keeps; opening the page changes nothing (scanners open links).
 */
export default function PasskeySetupPage() {
  const token = window.location.hash.replace(/^#/, '');
  const qc = useQueryClient();
  const navigate = useNavigate();
  const supported = browserSupportsWebAuthn();
  const info = useQuery({
    queryKey: ['passkey-setup', token],
    queryFn: () => post<PasskeySetupInfo>('/auth/passkey/setup/info', { token }),
    enabled: token.length >= 10,
    retry: false,
  });
  const add = useMutation({
    mutationFn: async () => {
      const options = await post<PasskeyOptions>('/auth/passkey/setup/options', { token });
      const response = await startRegistration({ optionsJSON: options as never });
      return post<Me>('/auth/passkey/setup', { token, response });
    },
    onSuccess: (me) => {
      qc.setQueryData(keys.me, me);
      navigate('/issues', { replace: true });
    },
  });
  const signOut = useMutation({
    mutationFn: () => post('/auth/logout'),
    onSuccess: async () => {
      qc.removeQueries({ queryKey: keys.me });
      await info.refetch();
    },
  });
  const gone = token.length < 10 || (info.error instanceof ApiError && info.error.status === 404);
  if (gone) {
    return (
      <Lone>
        <h1>{t('page.passkeySetup.gone')}</h1>
        <p className="note">{t('page.passkeySetup.goneAbout')}</p>
      </Lone>
    );
  }
  if (info.isLoading) {
    return (
      <Lone>
        <Loading />
      </Lone>
    );
  }
  if (info.error || !info.data) {
    return (
      <Lone>
        <ErrorNote error={info.error} />
      </Lone>
    );
  }
  const d = info.data;
  const cancelled = add.error ? passkeyCancelled(add.error) : false;
  return (
    <Lone>
      <h1>{t('page.passkeySetup.title')}</h1>
      <p>{t('page.passkeySetup.about', { name: d.name, login: d.login })}</p>
      <p className="note">{t('page.passkeySetup.until', { date: untilSaid(d.expiresAt) })}</p>
      {d.signedInAs ? (
        <>
          <p role="alert">{t('page.passkeySetup.signedInAs', { other: d.signedInAs, login: d.login })}</p>
          <div className="cluster">
            <button type="button" className="primary" onClick={() => signOut.mutate()} disabled={signOut.isPending}>
              {t('page.passkeySetup.signOut')}
            </button>
          </div>
        </>
      ) : (
        <>
          {supported ? null : <p className="note">{t('page.passkeySetup.notSupported')}</p>}
          {add.error && !cancelled ? <ErrorNote error={add.error} /> : null}
          {cancelled ? (
            <p className="note" role="status">
              {t('identity.passkeys.cancelled')}
            </p>
          ) : null}
          <div className="cluster">
            <button type="button" className="primary" disabled={!supported || add.isPending} onClick={() => add.mutate()}>
              {add.isPending ? t('page.passkeySetup.adding') : t('page.passkeySetup.add')}
            </button>
          </div>
        </>
      )}
    </Lone>
  );
}

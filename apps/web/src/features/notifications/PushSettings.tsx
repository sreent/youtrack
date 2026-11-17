/**
 * Push notifications, on the profile (D47): on or off for this device, how much they say, and the
 * devices they go to, any of which can be removed from here (a phone left behind).
 */
import type { EmailLevel, Me, PushKey } from '@a4a/shared';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useId, useState } from 'react';
import { get } from '../../api/client';
import { ago } from '../../components/Badges';
import { ErrorNote, Loading } from '../../components/States';
import { errorText, Said } from '../common/bits';
import { useNotificationSettings, useSaveNotificationSettings } from './api';
import { currentSubscription, pushKeys, pushSupport, turnPushOff, turnPushOn, usePushDevices, useRemoveDevice, useTestPush } from './push';
import { t, tr } from '../../i18n';

const LEVELS: { value: EmailLevel; name: string; about: string }[] = [
  { value: 'all', name: t('notifications.pushSettings.everything'), about: t('notifications.pushSettings.mentionsAndAssignmentsChangesOn') },
  { value: 'direct', name: t('notifications.pushSettings.mentionsAndAssignments'), about: t('notifications.pushSettings.whenYouReMentionedOr') },
  { value: 'none', name: t('notifications.pushSettings.never'), about: t('notifications.pushSettings.nothingToYourDevicesYour') },
];

function failureText(e: unknown): string {
  return e instanceof Error && !('status' in e) ? e.message : errorText(e);
}

export function PushSettings({ me }: { me: Me }) {
  const qc = useQueryClient();
  const settings = useNotificationSettings();
  const save = useSaveNotificationSettings();
  const key = useQuery({ queryKey: ['push', 'key'], queryFn: () => get<PushKey>('/push/key'), staleTime: Infinity });
  const support = pushSupport();
  // This device's subscription: undefined until the browser has said.
  const [endpoint, setEndpoint] = useState<string | null | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [said, setSaid] = useState<{ text: string; bad?: boolean } | null>(null);
  const name = useId();
  useEffect(() => {
    currentSubscription()
      .then((s) => setEndpoint(s?.endpoint ?? null))
      .catch(() => setEndpoint(null));
  }, []);
  const devices = usePushDevices(endpoint ?? null, endpoint !== undefined);
  const remove = useRemoveDevice();
  const test = useTestPush();
  if (settings.isLoading || key.isLoading) return <Loading what="loadingLine.pushSettings" />;
  if (settings.error || !settings.data) return <ErrorNote error={settings.error} />;
  if (key.data && !key.data.enabled) return <p className="note">{t('notifications.pushSettings.thisServerSendsNoPush')}</p>;
  const here = devices.data?.find((d) => d.current);
  const denied = 'Notification' in window && Notification.permission === 'denied';

  const on = async () => {
    setBusy(true);
    setSaid(null);
    try {
      await turnPushOn(me);
      setEndpoint((await currentSubscription())?.endpoint ?? null);
      await qc.invalidateQueries({ queryKey: pushKeys.all });
      setSaid({ text: t('notifications.pushSettings.pushNotificationsAreOnFor') });
    } catch (e) {
      setSaid({ text: failureText(e), bad: true });
    } finally {
      setBusy(false);
    }
  };
  const off = async () => {
    setBusy(true);
    setSaid(null);
    try {
      await turnPushOff(here);
      setEndpoint(null);
      await qc.invalidateQueries({ queryKey: pushKeys.all });
      setSaid({ text: t('notifications.pushSettings.pushNotificationsAreOffOn') });
    } finally {
      setBusy(false);
    }
  };
  const sendTest = () =>
    test.mutate(undefined, {
      onSuccess: (r) =>
        setSaid(
          r.failed.length
            ? { text: t('notifications.pushSettings.sentTo', { sent: r.sent, join: r.failed.map((f) => `${f.device}: ${f.error}`).join(' ') }), bad: true }
            : { text: r.sent === 1 ? t('notifications.pushSettings.sentItShouldBeOn') : t('notifications.pushSettings.sentToYourDevices', { sent: r.sent }) },
        ),
      onError: (e) => setSaid({ text: errorText(e), bad: true }),
    });

  return (
    <div className="stack">
      {support.kind === 'install-first' ? (
        <p className="note">{t('notifications.pushSettings.onAnIphoneOrIpad')}</p>
      ) : support.kind === 'unsupported' ? (
        <p className="note">{t('notifications.pushSettings.thisBrowserCanTTake')}</p>
      ) : denied ? (
        <p className="note">{t('notifications.pushSettings.notificationsAreBlockedForA4a')}</p>
      ) : (
        <p className="note">{tr('notifications.pushSettings.signingOutHereTurnsThem', { v: here ? t('notifications.pushSettings.theyReOnForThis', { label: here.label }) : t('notifications.pushSettings.theyReOffOnThis') })}</p>
      )}
      {support.kind === 'ready' ? (
        <div className="cluster">
          {here ? (
            <button type="button" onClick={() => void off()} disabled={busy}>{t('notifications.pushSettings.turnOffOnThisDevice')}</button>
          ) : (
            <button type="button" className="primary" onClick={() => void on()} disabled={busy || denied || endpoint === undefined}>{t('notifications.pushSettings.turnOnForThisDevice')}</button>
          )}
          {devices.data?.length ? (
            <button type="button" onClick={sendTest} disabled={test.isPending}>{t('notifications.pushSettings.sendATest')}</button>
          ) : null}
        </div>
      ) : null}
      <fieldset className="choice-group column" disabled={save.isPending}>
        <legend>{t('notifications.pushSettings.pushToYourDevices')}</legend>
        {LEVELS.map((l) => (
          <label key={l.value} className="choice">
            <input
              type="radio"
              name={name}
              value={l.value}
              checked={settings.data.push === l.value}
              onChange={() =>
                save.mutate({ push: l.value }, { onSuccess: () => setSaid({ text: t('notifications.pushSettings.saved') }), onError: (e) => setSaid({ text: errorText(e), bad: true }) })
              }
            />
            <span>
              {l.name}
              <small className="field-help">{l.about}</small>
            </span>
          </label>
        ))}
      </fieldset>
      {devices.data?.length ? (
        <ul className="plain" aria-label={t('notifications.pushSettings.devicesPushNotificationsGoTo')}>
          {devices.data.map((d) => (
            <li key={d.id} className="cluster">
              <span>
                <strong>{d.label}</strong>
                {d.current ? <span className="badge">{t('notifications.pushSettings.thisDevice')}</span> : null}{' '}
                <span className="note">
                  {d.lastError ? t('notifications.pushSettings.itsPushServiceRefusedThe', { lastError: d.lastError }) : d.lastSentAt ? t('notifications.pushSettings.lastSent', { when: ago(d.lastSentAt) }) : t('notifications.pushSettings.added', { when: ago(d.createdAt) })}
                </span>
              </span>
              <button
                type="button"
                className="small"
                onClick={() => remove.mutate(d.id, { onSuccess: () => (d.current ? void turnPushOff(undefined).then(() => setEndpoint(null)) : undefined) })}
                disabled={remove.isPending}
                aria-label={t('notifications.pushSettings.stopPushNotificationsTo', { label: d.label, v: d.current ? t('notifications.pushSettings.thisDevice2') : '' })}
              >{t('notifications.pushSettings.remove')}</button>
            </li>
          ))}
        </ul>
      ) : null}
      <Said text={said?.text} tone={said?.bad ? 'bad' : undefined} />
    </div>
  );
}

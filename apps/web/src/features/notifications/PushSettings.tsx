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

const LEVELS: { value: EmailLevel; name: string; about: string }[] = [
  { value: 'all', name: 'Everything', about: 'Mentions and assignments, changes on issues you watch, and what you subscribe to.' },
  { value: 'direct', name: 'Mentions and assignments', about: "When you're mentioned or assigned an issue, and new help desk requests in a project you lead." },
  { value: 'none', name: 'Never', about: 'Nothing to your devices; your inbox still has everything.' },
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
  if (settings.isLoading || key.isLoading) return <Loading what="your push settings" />;
  if (settings.error || !settings.data) return <ErrorNote error={settings.error} />;
  if (key.data && !key.data.enabled) return <p className="note">This server sends no push notifications: an administrator turns them on (PUSH).</p>;
  const here = devices.data?.find((d) => d.current);
  const denied = 'Notification' in window && Notification.permission === 'denied';

  const on = async () => {
    setBusy(true);
    setSaid(null);
    try {
      await turnPushOn(me);
      setEndpoint((await currentSubscription())?.endpoint ?? null);
      await qc.invalidateQueries({ queryKey: pushKeys.all });
      setSaid({ text: 'Push notifications are on for this device.' });
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
      setSaid({ text: 'Push notifications are off on this device.' });
    } finally {
      setBusy(false);
    }
  };
  const sendTest = () =>
    test.mutate(undefined, {
      onSuccess: (r) =>
        setSaid(
          r.failed.length
            ? { text: `Sent to ${r.sent}. ${r.failed.map((f) => `${f.device}: ${f.error}`).join(' ')}`, bad: true }
            : { text: r.sent === 1 ? 'Sent: it should be on your device now.' : `Sent to your ${r.sent} devices.` },
        ),
      onError: (e) => setSaid({ text: errorText(e), bad: true }),
    });

  return (
    <div className="stack">
      {support.kind === 'install-first' ? (
        <p className="note">
          On an iPhone or iPad, a4a sends push notifications once it's on your Home Screen: tap Share, then Add to Home Screen, and turn them on in a4a
          opened from there.
        </p>
      ) : support.kind === 'unsupported' ? (
        <p className="note">This browser can't take push notifications. Chrome, Edge, Firefox and Safari can.</p>
      ) : denied ? (
        <p className="note">Notifications are blocked for a4a in this browser. Allow them in its site settings, then turn push on here.</p>
      ) : (
        <p className="note">{here ? `They're on for this device (${here.label}).` : "They're off on this device."} Signing out here turns them off.</p>
      )}
      {support.kind === 'ready' ? (
        <div className="cluster">
          {here ? (
            <button type="button" onClick={() => void off()} disabled={busy}>
              Turn off on this device
            </button>
          ) : (
            <button type="button" className="primary" onClick={() => void on()} disabled={busy || denied || endpoint === undefined}>
              Turn on for this device
            </button>
          )}
          {devices.data?.length ? (
            <button type="button" onClick={sendTest} disabled={test.isPending}>
              Send a test
            </button>
          ) : null}
        </div>
      ) : null}
      <fieldset className="choice-group column" disabled={save.isPending}>
        <legend>Push to your devices</legend>
        {LEVELS.map((l) => (
          <label key={l.value} className="choice">
            <input
              type="radio"
              name={name}
              value={l.value}
              checked={settings.data.push === l.value}
              onChange={() =>
                save.mutate({ push: l.value }, { onSuccess: () => setSaid({ text: 'Saved.' }), onError: (e) => setSaid({ text: errorText(e), bad: true }) })
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
        <ul className="plain" aria-label="Devices push notifications go to">
          {devices.data.map((d) => (
            <li key={d.id} className="cluster">
              <span>
                <strong>{d.label}</strong>
                {d.current ? <span className="badge">this device</span> : null}{' '}
                <span className="note">
                  {d.lastError ? `its push service refused the last: ${d.lastError}` : d.lastSentAt ? `last sent ${ago(d.lastSentAt)}` : `added ${ago(d.createdAt)}`}
                </span>
              </span>
              <button
                type="button"
                className="small"
                onClick={() => remove.mutate(d.id, { onSuccess: () => (d.current ? void turnPushOff(undefined).then(() => setEndpoint(null)) : undefined) })}
                disabled={remove.isPending}
                aria-label={`Stop push notifications to ${d.label}${d.current ? ' (this device)' : ''}`}
              >
                Remove
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      <Said text={said?.text} tone={said?.bad ? 'bad' : undefined} />
    </div>
  );
}

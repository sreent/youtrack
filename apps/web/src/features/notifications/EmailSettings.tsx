import type { EmailLevel } from '@a4a/shared';
import { useId, useState } from 'react';
import { Link } from 'react-router';
import { ErrorNote, Loading } from '../../components/States';
import { errorText, Said } from '../common/bits';
import { useNotificationSettings, useSaveNotificationSettings } from './api';
import { t, tr } from '../../i18n';
import type { ReactNode } from 'react';

const LEVELS: { value: EmailLevel; name: string; about: string }[] = [
  {
    value: 'all',
    name: 'Everything',
    about: t('notifications.emailSettings.mentionsAndAssignmentsAndChanges'),
  },
  { value: 'direct', name: 'Mentions and assignments', about: t('notifications.emailSettings.whenYouReMentionedOr') },
  { value: 'none', name: 'Never', about: t('notifications.emailSettings.nothingByEmailWhatYou') },
];

/** What a4a emails you. Your inbox in a4a always has everything; this is only what also comes by email. */
export function EmailSettings() {
  const settings = useNotificationSettings();
  const save = useSaveNotificationSettings();
  const [said, setSaid] = useState<{ text: string; bad?: boolean } | null>(null);
  const name = useId();
  if (settings.isLoading) return <Loading what={t('notifications.emailSettings.yourEmailSettings')} />;
  if (settings.error || !settings.data) return <ErrorNote error={settings.error} />;
  const s = settings.data;
  const change = (body: { email?: EmailLevel; digest?: boolean }) =>
    save.mutate(body, {
      onSuccess: () => setSaid({ text: t('notifications.emailSettings.saved') }),
      onError: (e) => setSaid({ text: errorText(e), bad: true }),
    });
  const hour = `${String(s.digestHour).padStart(2, '0')}:00`;
  return (
    <div className="stack">
      {!s.mailConfigured ? (
        <p className="note">{t('notifications.emailSettings.thisServerSendsNoEmail')}</p>
      ) : !s.address ? (
        <p className="note">{tr('notifications.emailSettings.youHaveNoEmailAddress', { t0: (c: ReactNode) => <a href="#you">{c}</a> })}</p>
      ) : (
        <p className="note">{tr('notifications.emailSettings.emailsGoToEachHas', { address: s.address, t0: (c: ReactNode) => <strong>{c}</strong> })}</p>
      )}
      <fieldset className="choice-group column" disabled={save.isPending}>
        <legend>{t('notifications.emailSettings.emailMeAboutIssues')}</legend>
        {LEVELS.map((l) => (
          <label key={l.value} className="choice">
            <input type="radio" name={name} value={l.value} checked={s.email === l.value} onChange={() => change({ email: l.value })} />
            <span>
              {l.name}
              <small className="field-help">{l.about}</small>
            </span>
          </label>
        ))}
      </fieldset>
      <label className="choice">
        <input type="checkbox" checked={s.digest} disabled={save.isPending} onChange={(e) => change({ digest: e.target.checked })} />
        <span>{tr('notifications.emailSettings.aDailyDigestOnceA', { hour: hour, replaceAll: s.timeZone.replaceAll('_', ' '), t0: (c: ReactNode) => <small className="field-help">{c}</small> })}</span>
      </label>
      <p className="note">{tr('notifications.emailSettings.yourInboxAlwaysHasEverything', { t0: (c: ReactNode) => <Link to="/inbox">{c}</Link> })}</p>
      <Said text={said?.text} tone={said?.bad ? 'bad' : undefined} />
    </div>
  );
}

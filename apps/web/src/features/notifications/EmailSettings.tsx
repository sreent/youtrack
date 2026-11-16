import type { EmailLevel } from '@a4a/shared';
import { useId, useState } from 'react';
import { Link } from 'react-router';
import { ErrorNote, Loading } from '../../components/States';
import { errorText, Said } from '../common/bits';
import { useNotificationSettings, useSaveNotificationSettings } from './api';

const LEVELS: { value: EmailLevel; name: string; about: string }[] = [
  {
    value: 'all',
    name: 'Everything',
    about: 'Mentions and assignments, and changes on issues you watch: each a few minutes after it starts, with what came close behind it in the same email.',
  },
  { value: 'direct', name: 'Mentions and assignments', about: "When you're mentioned or assigned an issue, and about new help desk requests in a project you lead." },
  { value: 'none', name: 'Never', about: 'Nothing by email, what you subscribe to included.' },
];

/** What a4a emails you. Your inbox in a4a always has everything; this is only what also comes by email. */
export function EmailSettings() {
  const settings = useNotificationSettings();
  const save = useSaveNotificationSettings();
  const [said, setSaid] = useState<{ text: string; bad?: boolean } | null>(null);
  const name = useId();
  if (settings.isLoading) return <Loading what="your email settings" />;
  if (settings.error || !settings.data) return <ErrorNote error={settings.error} />;
  const s = settings.data;
  const change = (body: { email?: EmailLevel; digest?: boolean }) =>
    save.mutate(body, {
      onSuccess: () => setSaid({ text: 'Saved.' }),
      onError: (e) => setSaid({ text: errorText(e), bad: true }),
    });
  const hour = `${String(s.digestHour).padStart(2, '0')}:00`;
  return (
    <div className="stack">
      {!s.mailConfigured ? (
        <p className="note">This server sends no email yet (an administrator sets SMTP_URL), so for now everything stays in your inbox. Your choice here waits for it.</p>
      ) : !s.address ? (
        <p className="note">
          You have no email address, so nothing can reach you by email. Add one under <a href="#you">You</a>.
        </p>
      ) : (
        <p className="note">
          Emails go to <strong>{s.address}</strong>. Each has a link that stops its kind in one click.
        </p>
      )}
      <fieldset className="choice-group column" disabled={save.isPending}>
        <legend>Email me about issues</legend>
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
        <span>
          A daily digest
          <small className="field-help">
            Once a day, at {hour} your time ({s.timeZone.replaceAll('_', ' ')}): what's still unread and wasn't emailed already. Nothing to say, no email.
          </small>
        </span>
      </label>
      <p className="note">
        Your <Link to="/inbox">inbox</Link> always has everything, whatever you choose here. What you subscribe to says for itself whether it emails you, below.
      </p>
      <Said text={said?.text} tone={said?.bad ? 'bad' : undefined} />
    </div>
  );
}

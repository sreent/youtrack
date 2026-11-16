import type { CaptchaChallenge, CaptchaSolution, HelpForm, HelpRequestReceived } from '@a4a/shared';
import { HELP_LIMITS } from '@a4a/shared/constants';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { useParams } from 'react-router';
import { ApiError, get, post } from '../api/client';
import { Lone } from '../app/Auth';
import { Markdown } from '../components/Markdown';
import { ErrorNote, Loading } from '../components/States';
import { FormField } from '../features/common/bits';
import { CopyButton } from '../features/common/CopyButton';
import { solveCaptcha } from '../features/helpdesk/pow';
import { t, tr } from '../i18n';
import type { ReactNode } from 'react';

function Received({ r, project }: { r: HelpRequestReceived; project: string }) {
  return (
    <>
      <p className="label">{tr('page.help.helpDesk', { project: project })}</p>
      <h1>{t('page.help.weHaveYourRequest')}</h1>
      {r.tracking ? (
        <>
          <p>{t('page.help.keepThisLinkItS')}</p>
          <p className="cluster">
            <a href={r.tracking}>{t('page.help.followYourRequest')}</a>
            <CopyButton text={r.tracking} what={t('page.help.theLink')} label={t('page.help.copyTheLink')} />
          </p>
        </>
      ) : (
        <p>{tr('page.help.weVeEmailedALink', { email: r.email, t0: (c: ReactNode) => <strong>{c}</strong> })}</p>
      )}
    </>
  );
}

/**
 * The form's proof of work, when its desk asks for one (D30): solved in the background from the
 * moment the form loads, so it's usually ready before the person is. A new challenge starts anew.
 */
function useCaptcha(challenge: CaptchaChallenge | null | undefined) {
  const pending = useRef<Promise<CaptchaSolution> | null>(null);
  useEffect(() => {
    if (!challenge) {
      pending.current = null;
      return;
    }
    const run = solveCaptcha(challenge);
    pending.current = run.done;
    run.done.catch(() => {}); // asked for when the form is sent, and said there
    return () => run.stop();
  }, [challenge?.signature]); // the signature names the challenge: a new one starts anew
  return () => pending.current;
}

/** A project's help desk: a public form, for anyone, without signing in (Ocean's HelpDesk). */
export default function HelpPage() {
  const { key = '' } = useParams();
  const form = useQuery({ queryKey: ['help', key], queryFn: () => get<HelpForm>(`/help/${encodeURIComponent(key)}`), retry: false, refetchOnWindowFocus: false });
  const [fields, setFields] = useState({ name: '', email: '', summary: '', description: '', website: '' });
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState<false | 'checking' | 'sending'>(false);
  const [received, setReceived] = useState<HelpRequestReceived | null>(null);
  const captcha = useCaptcha(form.data?.captcha);
  useEffect(() => {
    if (form.data) document.title = `Ask ${form.data.project.name} for help`;
  }, [form.data]);

  if (form.isLoading) {
    return (
      <Lone wide>
        <Loading what={t('page.help.theForm')} />
      </Lone>
    );
  }
  if (form.error || !form.data) {
    const missing = form.error instanceof ApiError && form.error.status === 404;
    return (
      <Lone wide>
        <h1>{missing ? t('page.help.thereSNoHelpDesk') : t('page.help.theFormDidnTLoad')}</h1>
        {missing ? <p className="note">{t('page.help.checkTheAddressYouWere')}</p> : <ErrorNote error={form.error} />}
      </Lone>
    );
  }
  const f = form.data;
  if (received) {
    return (
      <Lone wide>
        <Received r={received} project={f.project.name} />
      </Lone>
    );
  }
  const set = (k: keyof typeof fields) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => setFields((x) => ({ ...x, [k]: e.target.value }));
  const send = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    let solved: CaptchaSolution | undefined;
    try {
      const pending = captcha();
      if (pending) {
        setBusy('checking');
        solved = await pending;
      }
      setBusy('sending');
      setReceived(await post<HelpRequestReceived>(`/help/${encodeURIComponent(f.project.key)}/requests`, { ...fields, csrf: f.csrf, ...(solved ? { captcha: solved } : {}) }));
    } catch (err) {
      setError(err);
      // An expired form gets a fresh one, and so does a check once its answer has gone to the server,
      // since each answer counts once; what was typed stays.
      if (err instanceof ApiError && (err.code === 'form_expired' || solved)) void form.refetch();
    } finally {
      setBusy(false);
    }
  };
  return (
    <Lone wide>
      <p className="label">{tr('page.help.helpDesk2', { name: f.project.name })}</p>
      <h1>{tr('page.help.askForHelp', { name: f.project.name })}</h1>
      {f.intro.trim() ? <Markdown text={f.intro} outside /> : null}
      <p className="note">
        {f.intro.trim() ? null : t('page.help.sayWhatSWrongOr')}
        {f.email ? (
          <>{tr('page.help.orWriteToAndAnswer', { email: f.email, t0: (c: ReactNode) => <a href={`mailto:${f.email}`}>{c}</a> })}</>
        ) : null}
      </p>
      <form className="form" onSubmit={send}>
        <div className="form-fields">
          <FormField label={t('page.help.yourName')}>{(id) => <input id={id} value={fields.name} onChange={set('name')} required maxLength={HELP_LIMITS.name} autoComplete="name" />}</FormField>
          <FormField label={t('page.help.yourEmail')} help={f.mail ? t('page.help.whereWeLlSendThe') : undefined}>
            {(id, help) => (
              <input id={id} type="email" value={fields.email} onChange={set('email')} required maxLength={HELP_LIMITS.email} autoComplete="email" aria-describedby={help} />
            )}
          </FormField>
        </div>
        <FormField label={t('page.help.whatItSAbout')} help={t('page.help.aLineWhatYouWere')}>
          {(id, help) => <input id={id} value={fields.summary} onChange={set('summary')} required minLength={3} maxLength={HELP_LIMITS.summary} aria-describedby={help} />}
        </FormField>
        <FormField label={t('page.help.theDetails')} help={t('page.help.whatYouDidWhatYou')}>
          {(id, help) => <textarea id={id} rows={7} value={fields.description} onChange={set('description')} maxLength={HELP_LIMITS.description} aria-describedby={help} />}
        </FormField>
        {/* A trap for bots: people never see it, and nothing is filed when it's filled in. */}
        <div className="hidden" aria-hidden="true">
          <label htmlFor="help-website">{t('page.help.leaveThisEmpty')}</label>
          <input id="help-website" name="website" tabIndex={-1} autoComplete="off" value={fields.website} onChange={set('website')} />
        </div>
        {error ? <ErrorNote error={error} /> : null}
        <div className="cluster end">
          {busy === 'checking' ? (
            <p className="note" role="status">{t('page.help.makingSureAPersonSent')}</p>
          ) : null}
          <button type="submit" className="primary" disabled={busy !== false}>
            {busy ? t('page.help.sending') : t('page.help.sendTheRequest')}
          </button>
        </div>
      </form>
    </Lone>
  );
}

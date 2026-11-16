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

function Received({ r, project }: { r: HelpRequestReceived; project: string }) {
  return (
    <>
      <p className="label">{project} · help desk</p>
      <h1>We have your request</h1>
      {r.tracking ? (
        <>
          <p>Keep this link: it's the only way back to your request, where the team's replies will be, and where you can answer them.</p>
          <p className="cluster">
            <a href={r.tracking}>Follow your request</a>
            <CopyButton text={r.tracking} what="the link" label="Copy the link" />
          </p>
        </>
      ) : (
        <p>
          We've emailed a link to follow it to <strong>{r.email}</strong>. The team's replies will come there too. If it isn't there in a few minutes, look among your
          spam.
        </p>
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
        <Loading what="the form" />
      </Lone>
    );
  }
  if (form.error || !form.data) {
    const missing = form.error instanceof ApiError && form.error.status === 404;
    return (
      <Lone wide>
        <h1>{missing ? "There's no help desk here" : "The form didn't load"}</h1>
        {missing ? <p className="note">Check the address you were given.</p> : <ErrorNote error={form.error} />}
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
    try {
      let solved: CaptchaSolution | undefined;
      const pending = captcha();
      if (pending) {
        setBusy('checking');
        solved = await pending;
      }
      setBusy('sending');
      setReceived(await post<HelpRequestReceived>(`/help/${encodeURIComponent(f.project.key)}/requests`, { ...fields, csrf: f.csrf, ...(solved ? { captcha: solved } : {}) }));
    } catch (err) {
      setError(err);
      // An expired form, or a check that's spent, gets a fresh one; what was typed stays.
      if (err instanceof ApiError && ['form_expired', 'captcha_expired', 'captcha_failed'].includes(err.code)) void form.refetch();
    } finally {
      setBusy(false);
    }
  };
  return (
    <Lone wide>
      <p className="label">{f.project.name} · help desk</p>
      <h1>Ask {f.project.name} for help</h1>
      {f.intro.trim() ? <Markdown text={f.intro} outside /> : null}
      <p className="note">
        {f.intro.trim() ? null : "Say what's wrong or what you need. The team will reply on your request's own page. "}
        {f.email ? (
          <>
            Or write to <a href={`mailto:${f.email}`}>{f.email}</a>, and answer the team's emails.
          </>
        ) : null}
      </p>
      <form className="form" onSubmit={send}>
        <div className="form-fields">
          <FormField label="Your name">{(id) => <input id={id} value={fields.name} onChange={set('name')} required maxLength={HELP_LIMITS.name} autoComplete="name" />}</FormField>
          <FormField label="Your email" help={f.mail ? "Where we'll send the link to follow your request." : undefined}>
            {(id, help) => (
              <input id={id} type="email" value={fields.email} onChange={set('email')} required maxLength={HELP_LIMITS.email} autoComplete="email" aria-describedby={help} />
            )}
          </FormField>
        </div>
        <FormField label="What it's about" help="A line: what you were trying to do, and what happened.">
          {(id, help) => <input id={id} value={fields.summary} onChange={set('summary')} required minLength={3} maxLength={HELP_LIMITS.summary} aria-describedby={help} />}
        </FormField>
        <FormField label="The details" help="What you did, what you expected and what happened instead. Leave out passwords: anyone with the link can read this.">
          {(id, help) => <textarea id={id} rows={7} value={fields.description} onChange={set('description')} maxLength={HELP_LIMITS.description} aria-describedby={help} />}
        </FormField>
        {/* A trap for bots: people never see it, and nothing is filed when it's filled in. */}
        <div className="hidden" aria-hidden="true">
          <label htmlFor="help-website">Leave this empty</label>
          <input id="help-website" name="website" tabIndex={-1} autoComplete="off" value={fields.website} onChange={set('website')} />
        </div>
        {error ? <ErrorNote error={error} /> : null}
        <div className="cluster end">
          {busy === 'checking' ? (
            <p className="note" role="status">
              Making sure a person sent it: a moment.
            </p>
          ) : null}
          <button type="submit" className="primary" disabled={busy !== false}>
            {busy ? 'Sending…' : 'Send the request'}
          </button>
        </div>
      </form>
    </Lone>
  );
}

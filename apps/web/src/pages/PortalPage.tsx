import type { CaptchaChallenge, CaptchaSolution, CcConfirmation, CcConfirmed, PortalDesk, PortalMe, PortalRequest, PortalRequestDetail, PortalSignInMethods } from '@a4a/shared';
import { HELP_LIMITS } from '@a4a/shared/constants';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { api, ApiError, get, patch, post, put, qs } from '../api/client';
import { Lone } from '../app/Auth';
import { Badge } from '../components/Badges';
import { Markdown } from '../components/Markdown';
import { Icon } from '../components/Icon';
import { ErrorNote, Loading } from '../components/States';
import { Avatar, Who } from '../components/Who';
import { errorText, FormField } from '../features/common/bits';
import { solveCaptcha } from '../features/helpdesk/pow';
import { PortalNotMe, PortalPasskeyButton, PortalPasskeysSection, usePortalPasskeySignIn } from '../features/helpdesk/PortalPasskeys';
import { whenRead } from '../features/common/format';
import { formatList, intlLocale, t, tr } from '../i18n';
import type { ReactNode } from 'react';

/** A sign-in link's token is in the fragment, which never leaves the browser: it's sent once, then dropped. */
function linkToken(): string {
  const t = window.location.hash.replace(/^#/, '').trim();
  return /^hdl_[A-Za-z0-9_-]{43}$/.test(t) ? t : '';
}

/** The link that confirms whom a new request's Cc named (D67) carries its token the same way. */
function confirmToken(): string {
  const t = window.location.hash.replace(/^#/, '').trim();
  return /^hdc_[A-Za-z0-9_-]{43}$/.test(t) ? t : '';
}

/** A link to set a password (D63) carries its token the same way. */
function passwordToken(): string {
  const t = window.location.hash.replace(/^#/, '').trim();
  return /^hdp_[A-Za-z0-9_-]{43}$/.test(t) ? t : '';
}

/** A mail's "this wasn't me" link about their passkeys (D69) carries its token the same way. */
function alertToken(): string {
  const t = window.location.hash.replace(/^#/, '').trim();
  return /^hdk_[A-Za-z0-9_-]{43}$/.test(t) ? t : '';
}

/** The desk whose page this is: named, or the one a request's id names (an email to someone copied links to it, D57). */
function deskOfPage(): string | undefined {
  const q = new URLSearchParams(window.location.search);
  const named = q.get('desk')?.trim();
  if (named) return named.toUpperCase();
  const request = /^([A-Za-z][A-Za-z0-9_]*)-\d+$/.exec(q.get('request')?.trim() ?? '');
  return request ? request[1]!.toUpperCase() : undefined;
}

/**
 * A password sign-in's proof of work, when a desk that takes passwords asks for one (D30): solved in
 * the background from the moment the page loads, as the help desk's form solves its own.
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

/** Why signing in through a provider sent someone back (the callback's ?sso=), and what to do. */
function ssoFailure(code: string): { what: string; fix: string } {
  switch (code) {
    case 'cancelled':
      return { what: t('page.portal.ssoCancelled'), fix: t('page.portal.ssoCancelledFix') };
    case 'expired':
      return { what: t('page.portal.ssoExpired'), fix: t('page.portal.ssoExpiredFix') };
    case 'unverified':
      return { what: t('page.portal.ssoUnverified'), fix: t('page.portal.ssoUnverifiedFix') };
    case 'domain':
      return { what: t('page.portal.ssoDomain'), fix: t('page.portal.ssoAnotherWay') };
    case 'refused':
      return { what: t('page.portal.ssoRefused'), fix: t('page.portal.ssoAnotherWay') };
    default:
      return { what: t('page.portal.ssoFailed'), fix: t('page.portal.ssoFailedFix') };
  }
}

/**
 * Signing in (D45, D63): the ways the desk whose page this is takes, or, on the portal's own page,
 * those some desk takes. A password, an emailed link, and the desk's identity providers.
 */
function SignIn({ desk, onSignedIn }: { desk: string | undefined; onSignedIn: (me: PortalMe) => void }) {
  const methods = useQuery({
    queryKey: ['portal', 'methods', desk ?? ''],
    queryFn: () => get<PortalSignInMethods>(`/portal/sign-in-methods${desk ? `?desk=${encodeURIComponent(desk)}` : ''}`),
    retry: false,
    refetchOnWindowFocus: false,
  });
  const captcha = useCaptcha(methods.data?.captcha);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [sent, setSent] = useState<'link' | 'password' | null>(null);
  const [busy, setBusy] = useState<false | 'checking' | 'signing' | 'sending'>(false);
  const [error, setError] = useState<unknown>(null);
  const failed = new URLSearchParams(window.location.search).get('sso');
  const failure = failed ? ssoFailure(failed) : null;
  // A passkey (D69): from the email field's autofill where the browser offers it, and a button.
  const passkeys = usePortalPasskeySignIn(Boolean(methods.data?.passkey) && !sent, desk, onSignedIn);
  if (methods.error) return <Lone><ErrorNote error={methods.error} /></Lone>;
  if (!methods.data) return <Loone />;
  const m = methods.data;
  const where = m.desk ? { desk: m.desk.key } : {};
  const sendLink = async (kind: 'link' | 'password') => {
    setBusy('sending');
    setError(null);
    try {
      await post(kind === 'link' ? '/portal/sign-in' : '/portal/password/link', { email, ...where });
      setSent(kind);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };
  const signIn = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    try {
      let solved: CaptchaSolution | undefined;
      const pending = captcha();
      if (pending) {
        setBusy('checking');
        solved = await pending;
      }
      setBusy('signing');
      onSignedIn(await post<PortalMe>('/portal/password/sign-in', { email, password, ...where, ...(solved ? { captcha: solved } : {}) }));
    } catch (err) {
      setError(err);
      // A proof of work is taken once: a new one for the next try.
      if (methods.data?.captcha) void methods.refetch();
    } finally {
      setBusy(false);
    }
  };
  // A password signs in without email; a link needs it, and the server says so when it has none.
  const byEmail = m.link || m.password;
  const intro = m.password && m.link ? t('page.portal.linkOrPasswordIntro') : m.password ? t('page.portal.passwordIntro') : t('page.portal.weLlEmailYouA');
  return (
    <Lone>
      {m.desk ? <p className="label">{m.desk.name}</p> : null}
      <h1>{t('page.portal.yourRequests')}</h1>
      {failure ? (
        <div className="error-note" role="alert">
          <Icon name="cross" />
          <strong>{failure.what}</strong>
          <p>{failure.fix}</p>
        </div>
      ) : null}
      {sent ? (
        <p role="status">{sent === 'link' ? tr('page.portal.ifCanSignInA', { email }) : tr('page.portal.passwordLinkSent', { email })}</p>
      ) : (
        <>
          {m.providers.map((p) => (
            <a key={p.id} className={byEmail ? 'button' : 'button primary'} href={p.start}>
              {t('page.portal.signInThrough', { name: p.name })}
            </a>
          ))}
          {byEmail ? (
            <form className="form" onSubmit={m.password ? signIn : (e) => { e.preventDefault(); void sendLink('link'); }} aria-label={m.password ? t('page.portal.signInWithYourPassword') : t('page.portal.signInWithYourEmail')}>
              <p className="note">{intro}</p>
              <FormField label={t('page.portal.yourEmail')}>
                {(id) => <input id={id} type="email" required autoComplete={passkeys.on ? 'username webauthn' : 'email'} value={email} onChange={(e) => setEmail(e.target.value)} />}
              </FormField>
              {m.password ? (
                <FormField label={t('page.portal.password')}>
                  {(id) => <input id={id} type="password" autoComplete="current-password" value={password} maxLength={200} onChange={(e) => setPassword(e.target.value)} />}
                </FormField>
              ) : null}
              {error ? <ErrorNote error={error} /> : null}
              <div className="cluster end">
                {m.password ? (
                  <button type="button" className="link" disabled={Boolean(busy) || !email.trim()} onClick={() => void sendLink('password')}>
                    {t('page.portal.setOrResetPassword')}
                  </button>
                ) : null}
                {m.link ? (
                  <button type={m.password ? 'button' : 'submit'} className={m.password ? undefined : 'primary'} disabled={Boolean(busy) || !email.trim()} onClick={m.password ? () => void sendLink('link') : undefined}>
                    {busy === 'sending' && !m.password ? t('page.portal.sending') : t('page.portal.emailMeALink')}
                  </button>
                ) : null}
                {m.password ? (
                  <button type="submit" className="primary" disabled={Boolean(busy) || !email.trim() || !password}>
                    {busy === 'checking' || busy === 'signing' ? t('page.portal.signingIn') : t('page.portal.signIn')}
                  </button>
                ) : null}
              </div>
            </form>
          ) : null}
          <PortalPasskeyButton passkeys={passkeys} />
        </>
      )}
    </Lone>
  );
}

/** A link to set a password (D63): the requester chooses one, and is signed in with it. */
function ChoosePassword({ token, onSignedIn }: { token: string; onSignedIn: (me: PortalMe) => void }) {
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const expired = error instanceof ApiError && error.code === 'link_expired';
  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const me = await post<PortalMe>('/portal/password/set', { token, password });
      history.replaceState(null, '', `${window.location.pathname}${window.location.search}`);
      onSignedIn(me);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };
  if (expired) {
    return (
      <Lone>
        <h1>{t('page.portal.thisPasswordLinkHas')}</h1>
        <p className="note">{t('page.portal.passwordLinksWorkOnce')}</p>
        <a href={`/portal${window.location.search}`}>{t('page.portal.signInAgain')}</a>
      </Lone>
    );
  }
  return (
    <Lone>
      <h1>{t('page.portal.choosePassword')}</h1>
      <form className="form" onSubmit={save} aria-label={t('page.portal.choosePassword')}>
        <FormField label={t('page.portal.newPassword')} help={t('page.portal.passwordHelp')}>
          {(id, help) => <input id={id} type="password" required minLength={8} maxLength={200} autoComplete="new-password" aria-describedby={help} value={password} onChange={(e) => setPassword(e.target.value)} />}
        </FormField>
        {error ? <ErrorNote error={error} /> : null}
        <div className="cluster end">
          <button type="submit" className="primary" disabled={busy || password.length < 8}>
            {busy ? t('page.portal.saving') : t('page.portal.setThePassword')}
          </button>
        </div>
      </form>
    </Lone>
  );
}

/** How they signed in, and their password: changed with the one they have, or set by a link to their email (D63). */
function HowYouSignIn({ me, onChange }: { me: PortalMe; onChange: (me: PortalMe) => void }) {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [said, setSaid] = useState<string | null>(null);
  const via = me.signedInWith;
  const change = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setSaid(null);
    try {
      onChange(await put<PortalMe>('/portal/me/password', { current, password: next }));
      setCurrent('');
      setNext('');
      setSaid(t('page.portal.passwordChanged'));
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };
  const askForLink = async () => {
    setBusy(true);
    setError(null);
    setSaid(null);
    try {
      await post('/portal/password/link', { email: me.email });
      setSaid(t('page.portal.passwordLinkOnItsWay', { email: me.email }));
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="stack tight" aria-labelledby="portal-sign-in">
      <h2 id="portal-sign-in">{t('page.portal.howYouSignIn')}</h2>
      <p className="note">{via.method === 'passkey' ? t('page.portal.signedInWithPasskey') : t('page.portal.signedInWith', { method: via.method, provider: via.provider?.name ?? '' })}</p>
      {me.elsewhere.map((d) => (
        <div key={d.desk.key} className="cluster">
          <p className="note">
            {t('page.portal.elsewhere', {
              desk: d.desk.name,
              ways: formatList([
                ...(d.password ? [t('page.portal.wayPassword')] : []),
                ...(d.link ? [t('page.portal.wayLink')] : []),
                ...(d.passkey ? [t('page.portal.wayPasskey')] : []),
                ...d.providers.map((p) => p.name),
              ], 'disjunction'),
            })}
          </p>
          <button type="button" className="link" onClick={() => void post('/portal/sign-out').finally(() => window.location.assign(`/portal?desk=${encodeURIComponent(d.desk.key)}`))}>
            {t('page.portal.signInThere', { desk: d.desk.name })}
          </button>
        </div>
      ))}
      {me.password ? (
        <form className="form" onSubmit={change} aria-label={t('page.portal.changePassword')}>
          <FormField label={t('page.portal.currentPassword')}>{(id) => <input id={id} type="password" required autoComplete="current-password" maxLength={200} value={current} onChange={(e) => setCurrent(e.target.value)} />}</FormField>
          <FormField label={t('page.portal.newPassword')} help={t('page.portal.passwordHelp')}>
            {(id, help) => <input id={id} type="password" required minLength={8} maxLength={200} autoComplete="new-password" aria-describedby={help} value={next} onChange={(e) => setNext(e.target.value)} />}
          </FormField>
          {error ? <ErrorNote error={error} /> : null}
          <div className="cluster end">
            <button type="submit" disabled={busy || !current || next.length < 8}>
              {busy ? t('page.portal.saving') : t('page.portal.changePassword')}
            </button>
          </div>
        </form>
      ) : me.passwords ? (
        <div className="stack tight">
          <p className="note">{t('page.portal.setAPasswordHelp')}</p>
          {error ? <ErrorNote error={error} /> : null}
          <div className="cluster">
            <button type="button" disabled={busy} onClick={() => void askForLink()}>
              {t('page.portal.emailMeAPasswordLink')}
            </button>
          </div>
        </div>
      ) : null}
      {said ? <p role="status" className="outcome">{said}</p> : null}
    </section>
  );
}

function Conversation({ r, me }: { r: PortalRequestDetail; me: PortalMe }) {
  return (
    <ol className="history" aria-label={t('page.portal.theRequestAndTheReplies')}>
      <li>
        <Avatar kind="person" name={r.requester.mine ? me.name : r.requester.name} small />
        <div className="history-body">
          <p className="history-head">{tr('page.portal.asked', { v: r.requester.mine ? t('page.portal.you') : r.requester.name, t0: (c: ReactNode) => <strong className="who-name">{c}</strong>, whenRead: whenRead(r.createdAt), t1: (c: ReactNode) => <time dateTime={r.createdAt}>{c}</time> })}</p>
          {r.description.trim() ? (
            <div className="history-comment">
              <Markdown text={r.description} outside />
            </div>
          ) : null}
        </div>
      </li>
      {r.messages.map((m) => (
        <li key={m.id}>
          <Avatar kind="person" name={m.from === 'you' ? me.name : m.name} small />
          <div className="history-body">
            <p className="history-head">
              {tr('page.portal.messageHead', {
                name: m.from === 'you' ? t('page.portal.you') : m.name,
                from: m.from /* a stable code */,
                whenRead: whenRead(m.at),
                t0: (c: ReactNode) => <strong className="who-name">{c}</strong>,
                t1: (c: ReactNode) => <time dateTime={m.at}>{c}</time>,
              })}
            </p>
            <div className="history-comment">
              <Markdown text={m.text} outside />
            </div>
          </div>
        </li>
      ))}
    </ol>
  );
}

/**
 * Who is copied on a request, as its requester sees them on the portal (D57), and a way to copy
 * someone: anyone they choose, who then gets the team's replies by email and may reply.
 */
function Copied({ r, onChange }: { r: PortalRequestDetail; onChange: (d: PortalRequestDetail) => void }) {
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [said, setSaid] = useState<string | null>(null);
  if (!r.ccs) return null;
  // Its requester takes anyone off (D67), whoever copied them: they hear nothing more of it.
  const stop = async (who: string) => {
    setBusy(true);
    setError(null);
    setSaid(null);
    try {
      onChange(await api<PortalRequestDetail>('DELETE', `/portal/requests/${encodeURIComponent(r.id)}/ccs${qs({ email: who })}`));
      setSaid(t('page.portal.noLongerCopied', { email: who }));
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };
  const copy = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setSaid(null);
    try {
      const who = email.trim();
      onChange(await post<PortalRequestDetail>(`/portal/requests/${encodeURIComponent(r.id)}/ccs`, { email: who }));
      setEmail('');
      setSaid(t('page.portal.nowCopied', { email: who }));
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="stack tight" aria-labelledby="portal-copied">
      <h3 id="portal-copied">{t('page.portal.copied')}</h3>
      {r.ccs.length ? (
        <ul className="plain stack tight">
          {r.ccs.map((c) => (
            <li key={c.email} className="split">
              <Who kind="person" name={c.name || c.email} about={c.name ? `${c.email} · ${c.byYou ? t('page.portal.copiedByYou') : t('page.portal.copiedByTheTeam')}` : c.byYou ? t('page.portal.copiedByYou') : t('page.portal.copiedByTheTeam')} small />
              <button type="button" className="link" disabled={busy} aria-label={t('page.portal.stopCopyingWho', { email: c.email })} onClick={() => void stop(c.email)}>
                {t('page.portal.stopCopying')}
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="note">{t('page.portal.nobodyCopied')}</p>
      )}
      {r.ccs.length >= r.ccsMax ? <p className="note">{t('page.portal.capReached', { max: r.ccsMax })}</p> : null}
      <form className="form" onSubmit={copy} aria-label={t('page.portal.copySomeone')}>
        <FormField label={t('page.portal.theirEmail')} help={t('page.portal.copyHelp')}>
          {(fid, helpId) => <input id={fid} type="email" required autoComplete="off" maxLength={HELP_LIMITS.email} aria-describedby={helpId} value={email} onChange={(e) => setEmail(e.target.value)} />}
        </FormField>
        {error ? <ErrorNote error={error} /> : null}
        <div className="cluster end">
          <button type="submit" disabled={busy || !email.trim()}>
            {busy ? t('page.portal.copying') : t('page.portal.copySomeone')}
          </button>
        </div>
      </form>
      {said ? <p role="status" className="outcome">{said}</p> : null}
    </section>
  );
}

/**
 * Whom the Cc of the email that opened a request named, when a4a couldn't be sure who sent it (D67):
 * held, told nothing, until its requester copies them here or drops them.
 */
function Held({ r, onChange }: { r: PortalRequestDetail; onChange: (d: PortalRequestDetail) => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [said, setSaid] = useState<string | null>(null);
  if (!r.held?.length) return null;
  const settle = async (email: string, copy: boolean) => {
    setBusy(true);
    setError(null);
    setSaid(null);
    try {
      onChange(await post<PortalRequestDetail>(`/portal/requests/${encodeURIComponent(r.id)}/held-ccs`, { email, copy }));
      setSaid(copy ? t('page.portal.nowCopied', { email }) : t('page.portal.heldDropped', { email }));
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="stack tight" aria-labelledby="portal-held">
      <h3 id="portal-held">{t('page.portal.heldTitle')}</h3>
      <p className="note">{t('page.portal.heldNote')}</p>
      <ul className="plain stack tight">
        {r.held.map((h) => (
          <li key={h.email} className="split">
            <Who kind="person" name={h.name || h.email} about={h.name ? h.email : undefined} small />
            <div className="cluster">
              <button type="button" disabled={busy} aria-label={t('page.portal.copyHeldWho', { email: h.email })} onClick={() => void settle(h.email, true)}>
                {t('page.portal.copyHeld')}
              </button>
              <button type="button" className="link" disabled={busy} aria-label={t('page.portal.dropHeldWho', { email: h.email })} onClick={() => void settle(h.email, false)}>
                {t('page.portal.dropHeld')}
              </button>
            </div>
          </li>
        ))}
      </ul>
      {error ? <ErrorNote error={error} /> : null}
      {said ? <p role="status" className="outcome">{said}</p> : null}
    </section>
  );
}

/**
 * The link in a new request's acknowledgement (D67): whom its Cc named, to copy or not, once, without
 * signing in, since the link came to the requester's address. Opening it changes nothing.
 */
function ConfirmCopies({ token }: { token: string }) {
  const headers = { 'x-cc-confirmation': token };
  const q = useQuery({ queryKey: ['portal', 'cc-confirmation', token], queryFn: () => get<CcConfirmation>('/portal/cc-confirmation', { headers }), retry: false });
  const [chosen, setChosen] = useState<Set<string> | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [done, setDone] = useState<CcConfirmed | null>(null);
  useEffect(() => {
    document.title = t('page.portal.confirm.title');
  }, []);
  if (q.error) {
    return (
      <Lone>
        <h1>{t('page.portal.confirm.title')}</h1>
        <ErrorNote error={q.error} />
        <a href="/portal">{t('page.portal.confirm.openPortal')}</a>
      </Lone>
    );
  }
  if (!q.data) return <Loone />;
  const c = q.data;
  const picked = chosen ?? new Set(c.held.map((h) => h.email));
  const toggle = (email: string, on: boolean) => {
    const next = new Set(picked);
    if (on) next.add(email);
    else next.delete(email);
    setChosen(next);
  };
  const send = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      setDone(await post<CcConfirmed>('/portal/cc-confirmation', { copy: [...picked] }, { headers }));
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };
  const portal = `/portal?request=${encodeURIComponent(c.request.id)}`;
  return (
    <Lone>
      <h1>{t('page.portal.confirm.title')}</h1>
      {done ? (
        <div className="stack">
          <p role="status" className="outcome">
            {t('page.portal.confirm.copied', { count: done.copied.length })}
          </p>
          {done.dropped.length ? <p className="note">{t('page.portal.confirm.dropped', { count: done.dropped.length })}</p> : null}
          {done.refused.length ? (
            <ul className="plain stack tight">
              {done.refused.map((x) => (
                <li key={x.email} className="note">
                  {t('page.portal.confirm.notCopied', { email: x.email, why: errorText(x) })}
                </li>
              ))}
            </ul>
          ) : null}
          <a href={portal}>{t('page.portal.confirm.openPortal')}</a>
        </div>
      ) : c.held.length ? (
        <form className="form" onSubmit={send}>
          <p>{t('page.portal.confirm.lead', { desk: c.request.desk, summary: c.request.summary })}</p>
          <fieldset className="unframed form" disabled={busy}>
            <legend>{t('page.portal.confirm.chooseLabel')}</legend>
            {c.held.map((h) => (
              <label key={h.email} className="choice">
                <input type="checkbox" checked={picked.has(h.email)} onChange={(e) => toggle(h.email, e.target.checked)} />
                <Who kind="person" name={h.name || h.email} about={h.name ? h.email : undefined} small />
              </label>
            ))}
          </fieldset>
          {error ? <ErrorNote error={error} /> : null}
          <p className="note">{t('page.portal.confirm.until', { date: new Date(c.expiresAt).toLocaleString(intlLocale(), { dateStyle: 'medium', timeStyle: 'short' }) })}</p>
          <div className="cluster end">
            <button type="submit" className="primary" disabled={busy}>
              {busy ? t('page.portal.confirm.saving') : t('page.portal.confirm.copyThem')}
            </button>
          </div>
        </form>
      ) : (
        <div className="stack">
          <p className="note">{t('page.portal.confirm.nobody')}</p>
          <a href={portal}>{t('page.portal.confirm.openPortal')}</a>
        </div>
      )}
    </Lone>
  );
}

function RequestView({ id, me, onBack }: { id: string; me: PortalMe; onBack: () => void }) {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['portal', 'request', id], queryFn: () => get<PortalRequestDetail>(`/portal/requests/${encodeURIComponent(id)}`), retry: false });
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  if (q.error) return <ErrorNote error={q.error} />;
  if (!q.data) return <Loading what="loadingLine.request" />;
  const r = q.data;
  const reply = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      qc.setQueryData(['portal', 'request', id], await post<PortalRequestDetail>(`/portal/requests/${encodeURIComponent(id)}/replies`, { text }));
      setText('');
      void qc.invalidateQueries({ queryKey: ['portal', 'requests'] });
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };
  // Theirs, in a group that shares (D56): kept from it, or shared again.
  const keep = async (value: boolean) => {
    setBusy(true);
    setError(null);
    try {
      qc.setQueryData(['portal', 'request', id], await patch<PortalRequestDetail>(`/portal/requests/${encodeURIComponent(id)}`, { private: value }));
      void qc.invalidateQueries({ queryKey: ['portal', 'requests'] });
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="stack" aria-label={r.summary}>
      <button type="button" className="link" onClick={onBack}>{t('page.portal.allYourRequests')}</button>
      <p className="label">
        {r.desk.name} · {r.id}
      </p>
      <div className="title-row">
        <h2>{r.summary}</h2>
        {r.state.name ? <Badge tone={r.state.resolved ? 'good' : null}>{r.state.name}</Badge> : null}
      </div>
      <Conversation r={r} me={me} />
      {r.copied ? <p className="note">{t('page.portal.youAreCopied', { name: r.requester.name })}</p> : null}
      {r.requester.mine && r.group ? (
        <div className="cluster">
          <p className="note">{r.private ? t('page.portal.keptFromGroup') : t('page.portal.groupSeesIt', { group: r.group })}</p>
          <button type="button" className="link" disabled={busy} onClick={() => void keep(!r.private)}>
            {r.private ? t('page.portal.shareAgain', { group: r.group }) : t('page.portal.keepPrivate', { group: r.group })}
          </button>
        </div>
      ) : null}
      {!r.requester.mine && !r.copied && r.canReply ? <p className="note">{tr('page.portal.sharedToAnswer', { name: r.requester.name, group: r.group ?? '' })}</p> : null}
      {r.canReply ? (
        <form className="form" onSubmit={reply}>
          <FormField label={t('page.portal.yourReply')}>{(fid) => <textarea id={fid} rows={4} value={text} maxLength={HELP_LIMITS.reply} onChange={(e) => setText(e.target.value)} />}</FormField>
          {error ? <ErrorNote error={error} /> : null}
          <div className="cluster end">
            <button type="submit" className="primary" disabled={busy || !text.trim()}>
              {busy ? t('page.portal.sending') : t('page.portal.sendTheReply')}
            </button>
          </div>
        </form>
      ) : (
        <p className="note">{tr('page.portal.sharedReadOnly', { name: r.requester.name, group: r.group ?? '' })}</p>
      )}
      <Held r={r} onChange={(d) => qc.setQueryData(['portal', 'request', id], d)} />
      <Copied r={r} onChange={(d) => qc.setQueryData(['portal', 'request', id], d)} />
    </section>
  );
}

function NewRequest({ desks, me, onMade }: { desks: PortalDesk[]; me: PortalMe; onMade: (id: string) => void }) {
  const [desk, setDesk] = useState(desks[0]?.key ?? '');
  const [summary, setSummary] = useState('');
  const [description, setDescription] = useState('');
  const [keepPrivate, setKeepPrivate] = useState(false);
  const group = me.groups.find((g) => g.desk.key === desk);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  if (!desks.length) return null;
  const send = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      onMade((await post<PortalRequestDetail>('/portal/requests', { desk, summary, description, private: Boolean(group) && keepPrivate })).id);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };
  return (
    <form className="card form" onSubmit={send} aria-label={t('page.portal.askForHelp')}>
      <h2>{t('page.portal.askForHelp')}</h2>
      {desks.length > 1 ? (
        <FormField label={t('page.portal.helpDesk')}>
          {(id) => (
            <select id={id} value={desk} onChange={(e) => setDesk(e.target.value)}>
              {desks.map((d) => (
                <option key={d.key} value={d.key}>
                  {d.name}
                </option>
              ))}
            </select>
          )}
        </FormField>
      ) : null}
      <FormField label={t('page.portal.whatDoYouNeed')}>{(id) => <input id={id} required maxLength={HELP_LIMITS.summary} value={summary} onChange={(e) => setSummary(e.target.value)} />}</FormField>
      <FormField label={t('page.portal.details')}>{(id) => <textarea id={id} rows={4} maxLength={HELP_LIMITS.description} value={description} onChange={(e) => setDescription(e.target.value)} />}</FormField>
      {group ? (
        <label className="check">
          <input type="checkbox" checked={keepPrivate} onChange={(e) => setKeepPrivate(e.target.checked)} />
          {t('page.portal.keepFromMyGroup', { group: group.name })}
        </label>
      ) : null}
      {error ? <ErrorNote error={error} /> : null}
      <div className="cluster end">
        <button type="submit" className="primary" disabled={busy || !summary.trim()}>
          {busy ? t('page.portal.sending') : t('page.portal.sendTheRequest')}
        </button>
      </div>
    </form>
  );
}

/** The requesters' portal (D45): their requests, their customer group's where it shares them (D56), and a way to ask. */
export default function PortalPage() {
  const qc = useQueryClient();
  const [token, setToken] = useState(linkToken);
  const [settingPassword, setSettingPassword] = useState(passwordToken);
  // The link that confirms whom a new request's Cc named (D67): a page of its own, signed in or not.
  const [confirming] = useState(confirmToken);
  const [alert, setAlert] = useState(alertToken);
  const desk = deskOfPage();
  // A sign-in link opened where the portal already is changes only the address's hash: take it then too.
  useEffect(() => {
    const taken = () => {
      const next = linkToken();
      if (next) setToken(next);
      const chosen = passwordToken();
      if (chosen) setSettingPassword(chosen);
      const told = alertToken();
      if (told) setAlert(told);
    };
    window.addEventListener('hashchange', taken);
    return () => window.removeEventListener('hashchange', taken);
  }, []);
  const [redeemError, setRedeemError] = useState<unknown>(null);
  // An email to someone copied on a request links to it here (D57): opened once they're signed in.
  const [open, setOpen] = useState<string | null>(() => new URLSearchParams(window.location.search).get('request'));
  const me = useQuery({ queryKey: ['portal', 'me'], queryFn: () => get<PortalMe | null>('/portal/me'), retry: false, enabled: !token && !settingPassword && !confirming && !alert });
  useEffect(() => {
    if (!token) return;
    history.replaceState(null, '', window.location.pathname);
    post<PortalMe>('/portal/sign-in/redeem', { token })
      .then((m) => qc.setQueryData(['portal', 'me'], m))
      .catch(setRedeemError)
      .finally(() => void qc.invalidateQueries({ queryKey: ['portal'] }));
  }, [token, qc]);
  const signedIn = Boolean(me.data);
  const list = useQuery({ queryKey: ['portal', 'requests'], queryFn: () => get<PortalRequest[]>('/portal/requests'), enabled: signedIn });
  const desks = useQuery({ queryKey: ['portal', 'desks'], queryFn: () => get<PortalDesk[]>('/portal/desks'), enabled: signedIn });
  const [name, setName] = useState('');
  useEffect(() => {
    document.title = t('page.portal.yourRequests');
  }, []);

  if (confirming) return <ConfirmCopies token={confirming} />;
  if (redeemError) {
    return (
      <Lone>
        <h1>{t('page.portal.thisSignInLinkHas')}</h1>
        <p className="note">{t('page.portal.linksWorkOnceFor20')}</p>
        <a href="/portal">{t('page.portal.signInAgain')}</a>
      </Lone>
    );
  }
  const signedInNow = (m: PortalMe) => {
    qc.setQueryData(['portal', 'me'], m);
    setSettingPassword('');
    void qc.invalidateQueries({ queryKey: ['portal'], predicate: (q) => q.queryKey[1] !== 'me' });
  };
  if (alert) return <PortalNotMe token={alert} />;
  if (settingPassword) return <ChoosePassword token={settingPassword} onSignedIn={signedInNow} />;
  if (me.isLoading || (token && me.data === undefined && !me.error)) return <Loone />;
  if (!me.data) {
    if (me.error && !(me.error instanceof ApiError && me.error.status === 401)) return <Lone><ErrorNote error={me.error} /></Lone>;
    return <SignIn desk={desk} onSignedIn={signedInNow} />;
  }
  const m = me.data;
  const signOut = async () => {
    await post('/portal/sign-out');
    qc.removeQueries({ queryKey: ['portal'] });
    window.location.assign(desk ? `/portal?desk=${encodeURIComponent(desk)}` : '/portal');
  };
  return (
    <Lone wide>
      <div className="title-row">
        <h1>{t('page.portal.yourRequests')}</h1>
        <button type="button" onClick={() => void signOut()}>{t('page.portal.signOut')}</button>
      </div>
      <p className="note">
        {tr('page.portal.signedInAs', {
          name: m.name,
          email: m.email,
          // Whether they also see a customer group's requests (D56): each language ends the sentence its own way.
          hasGroups: m.groups.length ? 'yes' : 'no',
          groups: formatList(m.groups.map((g) => t('page.portal.groupAtDesk', { group: g.name, desk: g.desk.name }))),
        })}
      </p>
      {open ? (
        <RequestView id={open} me={m} onBack={() => setOpen(null)} />
      ) : (
        <div className="stack">
          {list.data?.length ? (
            <ul className="list" aria-label={t('page.portal.requests')}>
              {list.data.map((r) => (
                <li key={r.id} className="list-row">
                  <button type="button" className="link" onClick={() => setOpen(r.id)}>
                    {r.summary}
                  </button>
                  <span className="note">{tr(r.requester.mine ? 'page.portal.updatedYours' : 'page.portal.updatedTheirs', { name: r.desk.name, id: r.id, requester: r.requester.name, whenRead: whenRead(r.updatedAt) })}</span>
                  {r.state.name ? <Badge tone={r.state.resolved ? 'good' : null}>{r.state.name}</Badge> : null}
                  {r.copied ? <Badge grammar="outside">{t('page.portal.copied')}</Badge> : null}
                </li>
              ))}
            </ul>
          ) : list.isLoading ? (
            <Loading what="loadingLine.yourRequests" />
          ) : (
            <p className="note">{t('page.portal.noRequestsYet')}</p>
          )}
          <NewRequest desks={desks.data ?? []} me={m} onMade={(id) => { void qc.invalidateQueries({ queryKey: ['portal', 'requests'] }); setOpen(id); }} />
          <form
            className="form"
            aria-label={t('page.portal.yourName')}
            onSubmit={(e) => {
              e.preventDefault();
              void patch<PortalMe>('/portal/me', { name }).then((x) => qc.setQueryData(['portal', 'me'], x));
            }}
          >
            <FormField label={t('page.portal.theNameTheTeamSees')}>{(id) => <input id={id} placeholder={m.name} value={name} onChange={(e) => setName(e.target.value)} />}</FormField>
            <div className="cluster end">
              <button type="submit" disabled={!name.trim()}>{t('page.portal.changeMyName')}</button>
            </div>
          </form>
          <HowYouSignIn me={m} onChange={(x) => qc.setQueryData(['portal', 'me'], x)} />
          <PortalPasskeysSection me={m} />
        </div>
      )}
    </Lone>
  );
}

function Loone() {
  return (
    <Lone>
      <Loading what="loadingLine.yourRequests" />
    </Lone>
  );
}

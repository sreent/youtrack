import type { GuestInfo, Me, PasskeyOptions, RecoveryCodes, SignInStep, TwoFactorEnrolment } from '@a4a/shared';
import { browserSupportsWebAuthn, browserSupportsWebAuthnAutofill, startAuthentication, startRegistration, WebAuthnAbortService } from '@simplewebauthn/browser';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { Link, Navigate, useLocation, useNavigate, useSearchParams } from 'react-router';
import { ApiError, get, post } from '../api/client';
import { keys, useMe, useSetupStatus } from '../api/queries';
import { ErrorNote, Loading } from '../components/States';
import { Icon } from '../components/Icon';
import { Shell } from './Shell';
import { FormField } from '../components/Form';
import { CodeField, Enrol, RecoveryCodeList } from '../features/identity/TwoFactor';
import { passkeyAt, passkeyCancelled } from '../features/identity/Passkeys';
import { formatList, t, tr } from '../i18n';
import type { ReactNode } from 'react';

/** A page before the frame (Ocean's lone page): one card in the middle; `wide` for a conversation, as a help desk's. */
export function Lone({ children, wide }: { children: React.ReactNode; wide?: boolean }) {
  useEffect(() => {
    document.body.classList.add('lone');
    return () => document.body.classList.remove('lone');
  }, []);
  return <main className={wide ? 'card lone-card wide stack' : 'card lone-card stack'}>{children}</main>;
}

/** Signed-in pages: the frame, or the way to sign in / set up. */
export function RequireUser() {
  const setup = useSetupStatus();
  const me = useMe();
  const location = useLocation();
  if (setup.isLoading || me.isLoading) {
    return (
      <Lone>
        <Loading />
      </Lone>
    );
  }
  if (setup.data?.needsSetup) return <Navigate to="/setup" replace />;
  if (me.error instanceof ApiError && me.error.status === 401) {
    // Back where they were after signing in, whichever way they sign in.
    const here = `${location.pathname}${location.search}`;
    return <Navigate to={here === '/' || here === '/issues' ? '/login' : `/login?next=${encodeURIComponent(here)}`} replace />;
  }
  if (me.error || !me.data) {
    // Opened offline (the kept shell, D47): it says so, and opens by itself once back online.
    const offline = !navigator.onLine || (me.error instanceof TypeError && !(me.error instanceof ApiError));
    return (
      <Lone>
        {offline ? (
          <>
            <h1>{t('app.auth.youReOffline')}</h1>
            <p className="note">{t('app.auth.a4aOpensAsSoonAs')}</p>
            <div className="cluster">
              <button type="button" onClick={() => void me.refetch()}>{t('app.auth.tryAgain')}</button>
            </div>
          </>
        ) : (
          <ErrorNote error={me.error} />
        )}
      </Lone>
    );
  }
  return <Shell me={me.data} />;
}

function AuthCard({ title, about, children }: { title: string; about: string; children: React.ReactNode }) {
  return (
    <Lone>
      <span className="brand">
        <span className="mark">{t('app.auth.a4')}</span>
        <span>{t('app.auth.a4a')}</span>
      </span>
      <h1>{title}</h1>
      <p className="note">{about}</p>
      {children}
    </Lone>
  );
}

/** Why single sign-on sent someone back here (the callback's ?sso=), and what to do about it. */
/** A sign-in that failed, by the provider's name when there's one provider, else as "your identity provider" (`named`). */
function ssoFailure(code: string, name: string): { what: string; fix: string } {
  const who = { name, named: name ? 'yes' : 'no' };
  switch (code) {
    case 'cancelled':
      return { what: t('app.auth.signingInWithWasCancelled', who), fix: t('app.auth.signInAgainWhenYou') };
    case 'expired':
      return { what: t('app.auth.thatSignInRanOut'), fix: t('app.auth.startAgainHere') };
    case 'unverified':
      return { what: t('app.auth.hasnTVerifiedYourEmail', who), fix: t('app.auth.verifyItWithThenSign', who) };
    case 'domain':
      return { what: t('app.auth.accountsWithYourEmailS'), fix: t('app.auth.signInWithYourWork') };
    case 'no_account':
      return { what: t('app.auth.thereSNoA4aAccount'), fix: t('app.auth.askAnAdministratorToAdd') };
    case 'unconfirmed':
      return {
        what: t('app.auth.anA4aAccountHasYour'),
        fix: t('app.auth.askAnAdministratorToConfirm'),
      };
    case 'ambiguous':
      return { what: t('app.auth.moreThanOneA4aAccount'), fix: t('app.auth.askAnAdministratorToSort') };
    case 'refused':
      return { what: t('app.auth.thisAccountCanTSign', who), fix: t('app.auth.askAnAdministrator') };
    case 'unlinked':
      return {
        what: t('app.auth.anA4aAccountAlreadyHas', who),
        fix: t('app.auth.askAnAdministratorTheyCan', who),
      };
    default:
      return { what: t('app.auth.didnTSignYouIn', who), fix: t('app.auth.tryAgainIfItKeeps') };
  }
}

/**
 * The step after a right password (D38): a code from the app, or, where everyone is asked for one,
 * setting the app up first. A cookie good for ten minutes carries the sign-in between them.
 */
function SecondStep({ step: answer, next, onRestart }: { step: SignInStep; next: string; onRestart: () => void }) {
  const step = answer.step;
  // A passkey of theirs in place of the code (D62); without an app, it's the only way on.
  const passkey = Boolean(answer.passkey) && browserSupportsWebAuthn();
  const code = answer.code !== false;
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [typed, setTyped] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [enrolment, setEnrolment] = useState<TwoFactorEnrolment | null>(null);
  const [codes, setCodes] = useState<string[] | null>(null);
  const timedOut = error instanceof ApiError && error.status === 401;
  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };
  const again = (
    <button type="button" className="link" onClick={onRestart}>{t('app.auth.signInAgain')}</button>
  );
  const withPasskey = () =>
    void run(async () => {
      try {
        const me = await passkeyAt<Me>('/auth/two-factor/passkey/options', '/auth/two-factor/passkey');
        qc.setQueryData(keys.me, me);
        navigate(next);
      } catch (e) {
        if (!passkeyCancelled(e)) throw e;
      }
    });
  if (step === 'passkey_setup') return <OwedPasskey code={answer.code === true} next={next} again={again} />;
  if (step === 'two_factor') {
    return (
      <AuthCard title={t('app.auth.twoFactorSignIn')} about={code ? t('app.auth.yourPasswordWasRightNow') : t('app.auth.yourPasswordWasRightPasskey')}>
        {code ? (
          <form
            className="form"
            onSubmit={(e) => {
              e.preventDefault();
              void run(async () => {
                const me = await post<Me>('/auth/two-factor/verify', { code: typed.trim() });
                qc.setQueryData(keys.me, me);
                navigate(next);
              });
            }}
          >
            <CodeField value={typed} onChange={setTyped} recovery autoFocus />
            {error ? <ErrorNote error={error} /> : null}
            <button type="submit" className="primary" disabled={busy || typed.trim().length < 6}>
              {busy ? t('app.auth.checking') : t('app.auth.signIn')}
            </button>
          </form>
        ) : error ? (
          <ErrorNote error={error} />
        ) : null}
        {passkey ? (
          <button type="button" className={code ? undefined : 'primary'} disabled={busy} onClick={withPasskey}>
            {code ? t('app.auth.usePasskeyInstead') : t('app.auth.usePasskey')}
          </button>
        ) : null}
        {code ? <p className="note">{tr('app.auth.lostYourPhoneTypeOne', { v: timedOut ? again : null })}</p> : timedOut ? <p className="note">{again}</p> : null}
      </AuthCard>
    );
  }
  return (
    <AuthCard title={t('app.auth.setUpTwoFactorSign')} about={t('app.auth.thisInstanceAsksEveryoneWho')}>
      {codes ? (
        <>
          <RecoveryCodeList codes={codes} />
          <button type="button" className="primary" onClick={() => void qc.invalidateQueries({ queryKey: keys.me }).then(() => navigate(next))}>{t('app.auth.iVeKeptThemContinue')}</button>
        </>
      ) : enrolment ? (
        <Enrol enrolment={enrolment} confirm={(c) => post<RecoveryCodes>('/auth/two-factor/setup/confirm', { code: c })} onDone={setCodes} />
      ) : (
        <>
          <button type="button" className="primary" disabled={busy} onClick={() => void run(async () => setEnrolment(await post<TwoFactorEnrolment>('/auth/two-factor/setup')))}>
            {busy ? t('app.auth.starting') : t('app.auth.setItUp')}
          </button>
          {error ? <ErrorNote error={error} /> : null}
          {timedOut ? <p className="note">{again}</p> : null}
        </>
      )}
    </AuthCard>
  );
}

/**
 * Passkeys are required of them here and they have none (D68): the sign-in adds one before it
 * starts, with a code too where they have codes. For devices that can't, an administrator lets them off.
 */
function OwedPasskey({ code, next, again }: { code: boolean; next: string; again: ReactNode }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [typed, setTyped] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [cancelled, setCancelled] = useState(false);
  const supported = browserSupportsWebAuthn();
  const timedOut = error instanceof ApiError && error.status === 401;
  const add = async () => {
    setBusy(true);
    setError(null);
    setCancelled(false);
    try {
      const options = await post<PasskeyOptions>('/auth/two-factor/passkey-setup/options');
      const response = await startRegistration({ optionsJSON: options as never });
      const me = await post<Me>('/auth/two-factor/passkey-setup', { response, ...(code ? { code: typed.trim() } : {}) });
      qc.setQueryData(keys.me, me);
      navigate(next);
    } catch (e) {
      if (passkeyCancelled(e)) setCancelled(true);
      else setError(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <AuthCard title={t('app.auth.addAPasskeyToSignIn')} about={t('app.auth.passkeysAreRequiredOfYou')}>
      <form
        className="form"
        onSubmit={(e) => {
          e.preventDefault();
          void add();
        }}
      >
        {code ? <CodeField value={typed} onChange={setTyped} recovery autoFocus /> : null}
        {supported ? null : <p className="note">{t('app.auth.thisBrowserCantMakePasskeys')}</p>}
        {error ? <ErrorNote error={error} /> : null}
        {cancelled ? (
          <p className="note" role="status">
            {t('identity.passkeys.cancelled')}
          </p>
        ) : null}
        <button type="submit" className="primary" disabled={busy || !supported || (code && typed.trim().length < 6)}>
          {busy ? t('app.auth.waitingForYourPasskey') : t('app.auth.addAPasskey')}
        </button>
      </form>
      <p className="note">{t('app.auth.noDeviceCanMakeOne')}</p>
      {timedOut ? <p className="note">{again}</p> : null}
    </AuthCard>
  );
}

export function LoginPage() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const status = useSetupStatus();
  const [login, setLogin] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [step, setStep] = useState<SignInStep | null>(null);
  const raw = params.get('next') ?? '';
  const next = raw.startsWith('/') && !raw.startsWith('//') ? raw : '/issues';
  // OpenID Connect, SAML, or both (D16, D27).
  const providers = [status.data?.signIn.sso, status.data?.signIn.saml].filter((p): p is { name: string; url: string } => Boolean(p));
  const sso = providers.length ? { name: formatList(providers.map((p) => p.name), 'disjunction') } : null;
  // a4a's own passwords, a directory's (LDAP, D38), or both: one form either way.
  const ldap = status.data?.signIn.ldap ?? null;
  const own = status.data?.signIn.password ?? true;
  const passwords = own || Boolean(ldap);
  const formName = ldap && own ? t('app.auth.a4aOrLogin', { name: ldap.name }) : ldap ? t('app.auth.login2', { name: ldap.name }) : t('app.auth.a4aLogin');
  const failed = params.get('sso');
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const signedIn = await post<Me | SignInStep>('/auth/login', { login, password });
      if ('step' in signedIn) {
        WebAuthnAbortService.cancelCeremony();
        setStep(signedIn);
        return;
      }
      qc.setQueryData(keys.me, signedIn);
      navigate(next);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };
  const failure = failed && sso ? ssoFailure(failed, providers.length === 1 ? providers[0]!.name : '') : null;
  const passkeys = usePasskeySignIn(Boolean(status.data?.signIn.passkey) && !step, (me) => {
    qc.setQueryData(keys.me, me);
    navigate(next);
  });
  if (step) {
    return (
      <SecondStep
        step={step}
        next={next}
        onRestart={() => {
          setStep(null);
          setPassword('');
        }}
      />
    );
  }
  return (
    <AuthCard title={t('app.auth.signIn')} about={sso && !passwords ? t('app.auth.useYourAccount', { name: sso.name }) : sso ? t('app.auth.useYourAccountOrYour', { name: sso.name, formName: formName }) : t('app.auth.useYour', { formName: formName })}>
      {failure ? (
        <div className="error-note" role="alert">
          <Icon name="cross" />
          <strong>{failure.what}</strong>
          <p>{failure.fix}</p>
        </div>
      ) : null}
      {providers.map((p) => (
        <a key={p.url} className={passwords ? 'button' : 'button primary'} href={`${p.url}?next=${encodeURIComponent(next)}`}>{tr('app.auth.signInWith', { name: p.name })}</a>
      ))}
      {passwords ? (
        <form className="form" onSubmit={submit} aria-label={sso ? t('app.auth.signInWithYour', { formName: formName }) : undefined}>
          <FormField label={t('app.auth.login')}>
            {(id) => <input id={id} value={login} onChange={(e) => setLogin(e.target.value)} autoComplete={passkeys.on ? 'username webauthn' : 'username'} required autoFocus={!sso} />}
          </FormField>
          <FormField label={t('app.auth.password')}>
            {(id) => <input id={id} type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" required />}
          </FormField>
          {error ? <ErrorNote error={error} /> : null}
          <button type="submit" className="primary" disabled={busy}>
            {busy ? t('app.auth.signingIn') : t('app.auth.signIn')}
          </button>
        </form>
      ) : null}
      {passkeys.on ? (
        <>
          {passkeys.error ? <ErrorNote error={passkeys.error} /> : null}
          {passkeys.cancelled ? (
            <p className="note" role="status">
              {t('app.auth.passkeyCancelled')}
            </p>
          ) : null}
          <button type="button" disabled={passkeys.busy} onClick={passkeys.start}>
            {passkeys.busy ? t('app.auth.waitingForYourPasskey') : t('app.auth.signInWithAPasskey')}
          </button>
        </>
      ) : null}
      <GuestLink />
    </AuthCard>
  );
}

/**
 * Signing in with a passkey (D62): from the browser's autofill on the login field, where it offers
 * passkeys (conditional mediation), and from a button. The autofill's request waits as long as the
 * page is open, so it's asked again before its challenge runs out.
 */
function usePasskeySignIn(wanted: boolean, done: (me: Me) => void) {
  const on = wanted && browserSupportsWebAuthn();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [cancelled, setCancelled] = useState(false);
  const finished = useRef(done);
  finished.current = done;
  const ask = async (autofill: boolean) => {
    // Conditional UI can wait on only the current domain; a deliberate button press can try the old ones too (D70).
    if (!autofill) return finished.current(await passkeyAt<Me>('/auth/passkey/options', '/auth/passkey'));
    const options = await post<PasskeyOptions>('/auth/passkey/options');
    const response = await startAuthentication({ optionsJSON: options as never, useBrowserAutofill: true });
    finished.current(await post<Me>('/auth/passkey', { response }));
  };
  const [armed, setArmed] = useState(0);
  useEffect(() => {
    if (!on) return;
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    void browserSupportsWebAuthnAutofill().then((autofill) => {
      if (!live || !autofill) return;
      // Four minutes: the challenge lasts five.
      timer = setTimeout(() => setArmed((n) => n + 1), 4 * 60_000);
      ask(true).catch((e) => {
        if (!live || passkeyCancelled(e)) return;
        setError(e);
      });
    });
    return () => {
      live = false;
      if (timer) clearTimeout(timer);
      WebAuthnAbortService.cancelCeremony();
    };
  }, [on, armed]);
  const start = () => {
    setBusy(true);
    setError(null);
    setCancelled(false);
    ask(false)
      .catch((e) => (passkeyCancelled(e) ? setCancelled(true) : setError(e)))
      .finally(() => {
        setBusy(false);
        // The autofill's request was given up for the button's: ask for it again.
        setArmed((n) => n + 1);
      });
  };
  return { on, busy, error, cancelled, start };
}

export function SetupPage() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const status = useSetupStatus();
  const [form, setForm] = useState({ login: 'admin', name: '', email: '', password: '', seedDemo: true });
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  if (status.data && !status.data.needsSetup) return <Navigate to="/login" replace />;
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const me = await post<Me>('/auth/setup', { ...form, email: form.email || undefined });
      qc.setQueryData(keys.me, me);
      await qc.invalidateQueries({ queryKey: keys.setup });
      navigate('/issues');
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };
  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setForm((f) => ({ ...f, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value }));
  return (
    <AuthCard title={t('app.auth.setUpA4a')} about={t('app.auth.createTheFirstAdministratorYou')}>
      <form className="form" onSubmit={submit}>
        <FormField label={t('app.auth.yourName')}>{(id) => <input id={id} value={form.name} onChange={set('name')} required autoFocus />}</FormField>
        <FormField label={t('app.auth.login')}>{(id) => <input id={id} value={form.login} onChange={set('login')} required pattern="[a-zA-Z0-9._\-]+" />}</FormField>
        {status.data?.signIn.password === false ? (
          <FormField label={t('app.auth.emailYouLlSignIn', { v: status.data.signIn.sso?.name ?? status.data.signIn.saml?.name ?? t('app.auth.singleSignOn') })}>
            {(id) => <input id={id} type="email" value={form.email} onChange={set('email')} required autoComplete="email" />}
          </FormField>
        ) : (
          <FormField label={t('app.auth.emailOptional')}>{(id) => <input id={id} type="email" value={form.email} onChange={set('email')} />}</FormField>
        )}
        <FormField label={t('app.auth.passwordAtLeast8Characters')}>
          {(id) => <input id={id} type="password" value={form.password} onChange={set('password')} minLength={8} required autoComplete="new-password" />}
        </FormField>
        <label className="choice">
          <input type="checkbox" checked={form.seedDemo} onChange={set('seedDemo')} />
          <span>{t('app.auth.addDemoProjectsSoYou')}</span>
        </label>
        {error ? <ErrorNote error={error} /> : null}
        <button type="submit" className="primary" disabled={busy}>
          {busy ? t('app.auth.settingUp') : t('app.auth.createTheAdministrator')}
        </button>
      </form>
    </AuthCard>
  );
}

/** Where some projects are open to anyone (D37): a way in without signing in. */
function GuestLink() {
  const info = useQuery({ queryKey: ['guest'], queryFn: () => get<GuestInfo>('/guest'), staleTime: 60_000 });
  const projects = info.data?.projects ?? [];
  if (!projects.length) return null;
  return (
    <p className="note">{tr('app.auth.projectsOpenToAnyone', { join: formatList(projects.map((p) => p.name)), n: projects.length, t0: (c: ReactNode) => <Link to="/public">{c}</Link> })}</p>
  );
}

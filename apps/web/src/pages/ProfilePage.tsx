import type { Me } from '@a4a/shared';
import { NotifyKindsSettingsCard } from '../features/notifications/Kinds';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router';
import { patch } from '../api/client';
import { keys, useMe, useSetupStatus } from '../api/queries';
import { ErrorLine, Loading, PageHead } from '../components/States';
import { Avatar } from '../components/Who';
import { errorText, FormField, Said } from '../features/common/bits';
import { DaysAway } from '../features/away/DaysAway';
import { WorkWeek } from '../features/away/WorkWeek';
import { EmailSettings } from '../features/notifications/EmailSettings';
import { PushSettings } from '../features/notifications/PushSettings';
import { SubscriptionList } from '../features/notifications/Subscriptions';
import { emailKeys, YourEmails } from '../features/vcs/People';
import { CodeHostAccounts } from '../features/builds/Builds';
import { TwoFactorCard } from '../features/identity/TwoFactor';
import { ChatAccounts } from '../features/chat/Chat';
import { t, tr, useLocaleNow } from '../i18n';
import { isLocale, LOCALE_NAMES, LOCALES, matchLocale, type Locale } from '@a4a/shared/i18n';
import type { ReactNode } from 'react';

const ROLE_WORDS: Record<Me['role'], string> = {
  admin: t('page.profile.roleAdmin'),
  member: t('page.profile.roleMember'),
  viewer: t('page.profile.roleViewer'),
};

/** The language the browser asks for, as a4a would choose it with nothing on the profile. */
function browserLocale(serverDefault: Locale): Locale {
  return matchLocale(navigator.languages?.length ? navigator.languages : [navigator.language], serverDefault);
}

/** Every time zone the browser knows, with the browser's own and the one already chosen among them. */
function zoneNames(...also: (string | null)[]): string[] {
  const known = (Intl as unknown as { supportedValuesOf?: (key: string) => string[] }).supportedValuesOf?.('timeZone') ?? [];
  return [...new Set([...known, ...also.filter((z): z is string => Boolean(z))])].sort();
}

function browserZone(): string | null {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || null;
  } catch {
    return null;
  }
}

function You({ me }: { me: Me }) {
  const qc = useQueryClient();
  const [name, setName] = useState(me.name);
  const [email, setEmail] = useState(me.email ?? '');
  const [zone, setZone] = useState(me.timeZone ?? '');
  const [language, setLanguage] = useState<string>(me.locale ?? '');
  const [said, setSaid] = useState<{ text: string; bad?: boolean } | null>(null);
  useEffect(() => {
    setName(me.name);
    setEmail(me.email ?? '');
    setZone(me.timeZone ?? '');
    setLanguage(me.locale ?? '');
  }, [me.name, me.email, me.timeZone, me.locale]);
  const browser = useMemo(browserZone, []);
  const browserLanguage = useMemo(() => browserLocale(me.defaultLocale), [me.defaultLocale]);
  const zones = useMemo(() => zoneNames(browser, me.timeZone, me.serverTimeZone), [browser, me.timeZone, me.serverTimeZone]);
  const dirty = name !== me.name || email !== (me.email ?? '') || zone !== (me.timeZone ?? '') || language !== (me.locale ?? '');
  const save = useMutation({
    mutationFn: () => patch<Me>('/me', { name: name.trim(), email: email.trim() || null, timeZone: zone || null, locale: isLocale(language) ? language : null }),
    onSuccess: (m) => {
      qc.setQueryData(keys.me, m);
      void qc.invalidateQueries({ queryKey: keys.users });
      // Searches and email settings read dates where you are: ask again.
      void qc.invalidateQueries({ queryKey: ['notifications', 'settings'] });
      void qc.invalidateQueries({ queryKey: emailKeys.mine });
      setSaid({ text: m.name !== me.name ? t('page.profile.savedPeopleSeeYourNew') : t('page.profile.saved') });
      // Another language: the page says itself again in it (a reload, D49).
      useLocaleNow(m.locale);
    },
    onError: (e) => setSaid({ text: errorText(e), bad: true }),
  });
  return (
    <form
      className="form"
      onSubmit={(e) => {
        e.preventDefault();
        save.mutate();
      }}
    >
      <div className="form-fields">
        <FormField label={t('page.profile.name')}>
          {(id) => <input id={id} value={name} onChange={(e) => setName(e.target.value)} required maxLength={100} autoComplete="name" />}
        </FormField>
        <FormField label={t('page.profile.email')} help={t('page.profile.yourPrimaryEmailWhereA4a')}>
          {(id, help) => <input id={id} aria-describedby={help} type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" />}
        </FormField>
        <FormField
          label={t('page.profile.timeZone')}
          help={
            <>{tr('page.profile.whatTodayMeansInYour', { v: browser && browser !== (zone || me.serverTimeZone) ? (
                <>
                  {' '}
                  <button type="button" className="link" onClick={() => setZone(browser)}>{tr('page.profile.useYourBrowserS', { replaceAll: browser.replaceAll('_', ' ') })}</button>
                </>
              ) : null })}</>
          }
        >
          {(id, help) => (
            <select id={id} aria-describedby={help} value={zone} onChange={(e) => setZone(e.target.value)}>
              <option value="">{tr('page.profile.theServerS', { replaceAll: me.serverTimeZone.replaceAll('_', ' ') })}</option>
              {zones.map((z) => (
                <option key={z} value={z}>
                  {z.replaceAll('_', ' ')}
                </option>
              ))}
            </select>
          )}
        </FormField>
        <FormField label={t('page.profile.language')} help={t('page.profile.languageHelp')}>
          {(id, help) => (
            <select id={id} aria-describedby={help} value={language} onChange={(e) => setLanguage(e.target.value)}>
              <option value="">{t('page.profile.yourBrowsersLanguage', { name: LOCALE_NAMES[browserLanguage] })}</option>
              {LOCALES.map((l) => (
                // Each language by its own name, so whoever can't read this page still finds theirs.
                <option key={l} value={l} lang={l}>
                  {LOCALE_NAMES[l]}
                </option>
              ))}
            </select>
          )}
        </FormField>
      </div>
      <div className="cluster">
        <button type="submit" className="primary" disabled={!dirty || !name.trim() || save.isPending}>
          {save.isPending ? t('page.profile.saving') : t('page.profile.saveTheChanges')}
        </button>
        <Said text={said?.text} tone={said?.bad ? 'bad' : undefined} />
      </div>
    </form>
  );
}

function Password({ me }: { me: Me }) {
  const qc = useQueryClient();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [again, setAgain] = useState('');
  const [said, setSaid] = useState<{ text: string; bad?: boolean } | null>(null);
  const [changed, setChanged] = useState(false);
  const change = useMutation({
    mutationFn: () => patch<Me>('/me', { password: next, currentPassword: current }),
    onSuccess: () => {
      setCurrent('');
      setNext('');
      setAgain('');
      setChanged(true);
      setSaid({ text: t('page.profile.yourPasswordIsChangedAnd') });
    },
    onError: (e) => setSaid({ text: errorText(e), bad: true }),
  });
  const mismatch = again.length > 0 && again !== next;
  return (
    <form
      className="form"
      onSubmit={(e) => {
        e.preventDefault();
        if (next !== again) {
          setSaid({ text: t('page.profile.theNewPasswordsArenT'), bad: true });
          return;
        }
        change.mutate();
      }}
    >
      <input type="text" name="username" autoComplete="username" value={me.login} readOnly hidden />
      <div className="form-fields">
        <FormField label={t('page.profile.currentPassword')}>
          {(id) => <input id={id} type="password" value={current} onChange={(e) => setCurrent(e.target.value)} required autoComplete="current-password" />}
        </FormField>
        <FormField label={t('page.profile.newPassword')} help={t('page.profile.atLeast8Characters')}>
          {(id, help) => (
            <input
              id={id}
              type="password"
              value={next}
              onChange={(e) => setNext(e.target.value)}
              required
              minLength={8}
              autoComplete="new-password"
              aria-describedby={help}
            />
          )}
        </FormField>
        <FormField label={t('page.profile.theNewOneAgain')}>
          {(id) => (
            <>
              <input
                id={id}
                type="password"
                value={again}
                onChange={(e) => setAgain(e.target.value)}
                required
                minLength={8}
                autoComplete="new-password"
                aria-invalid={mismatch || undefined}
                aria-describedby={mismatch ? 'pw-mismatch' : undefined}
              />
              {mismatch ? <ErrorLine id="pw-mismatch">{t('page.profile.notTheSameAsThe')}</ErrorLine> : null}
            </>
          )}
        </FormField>
      </div>
      <div className="cluster">
        {changed ? (
          <Link className="button" to="/login" onClick={() => qc.clear()}>{t('page.profile.signInAgain')}</Link>
        ) : (
          <button type="submit" disabled={!current || next.length < 8 || mismatch || change.isPending}>
            {change.isPending ? t('page.profile.changing') : t('page.profile.changeThePassword')}
          </button>
        )}
        <Said text={said?.text} tone={said?.bad ? 'bad' : undefined} />
      </div>
    </form>
  );
}

/** How a4a names you, and how you sign in. */
export default function ProfilePage() {
  const me = useMe();
  const status = useSetupStatus();
  if (!me.data) return <Loading what={t('page.profile.yourProfile2')} />;
  const m = me.data;
  const sso = status.data?.signIn.sso ?? status.data?.signIn.saml ?? null;
  const passwords = status.data?.signIn.password ?? true;
  const ldap = status.data?.signIn.ldap ?? null;
  // A code after the password, for whoever signs in with one: a4a's or the directory's (D38).
  const signsInWithPassword = !m.isBot && ((passwords && m.signIn?.password !== false) || Boolean(ldap));
  return (
    <>
      <PageHead
        title={t('page.profile.yourProfile')}
        about={t('page.profile.howA4aNamesYouTo')}
        meta={
          <>
            <span className="tw:inline-flex tw:items-center tw:gap-2">
              <Avatar kind="person" name={m.name} small /> <span className="mono">{m.login}</span>
            </span>
            <span>{tr('page.profile.youRe', { v: ROLE_WORDS[m.role] })}</span>
          </>
        }
      />
      <section className="card" aria-labelledby="you">
        <h2 id="you">{t('page.profile.you')}</h2>
        <You me={m} />
      </section>
      <section className="card" aria-labelledby="emails">
        <div className="section-head">
          <h2 id="emails">{t('page.profile.emails')}</h2>
          <span className="note">{t('page.profile.whoseCommitsAreYours')}</span>
        </div>
        <YourEmails />
      </section>
      <CodeHostAccounts />
      <section className="card" aria-labelledby="notifications">
        <h2 id="notifications">{t('page.profile.notifications')}</h2>
        <EmailSettings />
        <NotifyKindsSettingsCard />
      </section>
      {m.isBot ? null : (
        <section className="card" aria-labelledby="push">
          <div className="section-head">
            <h2 id="push">{t('page.profile.pushNotifications')}</h2>
            <span className="note">{t('page.profile.onYourPhoneOrComputer')}</span>
          </div>
          <PushSettings me={m} />
        </section>
      )}
      <section className="card" aria-labelledby="away">
        <div className="section-head">
          <h2 id="away">{t('page.profile.daysAway')}</h2>
          <span className="note">{t('page.profile.plansSkipThemForYour')}</span>
        </div>
        <p className="section-note">{t('page.profile.everyoneSeesWhenYouRe')}</p>
        <DaysAway person={{ login: m.login, name: m.name }} you canEnter={m.auth.scopes.includes('write') && !m.isBot} />
      </section>

      <section className="card" aria-labelledby="week">
        <div className="section-head">
          <h2 id="week">{t('page.profile.workingWeek')}</h2>
          <span className="note">{t('page.profile.yourHoursEachDay')}</span>
        </div>
        <p className="section-note">{t('page.profile.partTimeOrAWeekday')}</p>
        <WorkWeek week={m.workWeek} capacity={m.capacityHoursPerDay} canChange={m.auth.scopes.includes('write') && !m.isBot} />
      </section>

      <section className="card" aria-labelledby="subscriptions">
        <div className="section-head">
          <h2 id="subscriptions">{t('page.profile.whatYouSubscribeTo')}</h2>
          <span className="note">{t('page.profile.projectsAndSavedSearchesYou')}</span>
        </div>
        <SubscriptionList />
      </section>
      <section className="card" aria-labelledby="password">
        <h2 id="password">{passwords ? t('page.profile.password') : t('page.profile.signingIn')}</h2>
        {passwords ? <Password me={m} /> : <p className="note">{tr('page.profile.youSignInWithPasswords', { v: sso?.name ?? t('page.profile.singleSignOn') })}</p>}
        {passwords && sso ? <p className="note">{tr('page.profile.youCanAlsoSignIn', { name: sso.name, name2: sso.name })}</p> : null}
      </section>
      {signsInWithPassword ? (
        <section className="card" aria-labelledby="two-factor">
          <div className="section-head">
            <h2 id="two-factor">{t('page.profile.twoFactorSignIn')}</h2>
            <span className="note">{t('page.profile.aCodeFromYourPhone')}</span>
          </div>
          <TwoFactorCard />
        </section>
      ) : null}
      <section className="card" aria-labelledby="chat-accounts">
        <div className="section-head">
          <h2 id="chat-accounts">{t('page.profile.chatAccounts')}</h2>
          <span className="note">{t('page.profile.teamsAndSlackAccountsThat')}</span>
        </div>
        <ChatAccounts />
      </section>
      <section className="card" aria-labelledby="agents">
        <h2 id="agents">{t('page.profile.tokensForAgentsAndScripts')}</h2>
        <p className="note">{tr('page.profile.anAgentOrAScript', { t0: (c: ReactNode) => <Link to="/agents">{c}</Link> })}</p>
      </section>
    </>
  );
}

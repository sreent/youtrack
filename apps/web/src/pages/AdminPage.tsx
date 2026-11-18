import type { PasskeyMetadata, PasskeySetupLink, PasskeysRequired, Role, Settings, TriageMode, User } from '@a4a/shared';
import { PASSKEYS_REQUIRED } from '@a4a/shared';
import { ROLES } from '@a4a/shared/constants';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { del, get, patch, post } from '../api/client';
import { keys, useMe, useSettings, useSetupStatus, useUsers } from '../api/queries';
import { ErrorNote, Loading, PageHead } from '../components/States';
import { Avatar } from '../components/Who';
import { agoSaid, Badge, untilSaid } from '../components/Badges';
import { AdminOnly, errorText, FormField, Said, Scroll } from '../features/common/bits';
import { LadderChoice } from '../features/common/Ladder';
import { GroupsSection } from '../features/groups/GroupsSection';
import { RolesSection } from '../features/roles/RolesSection';
import { ProvisioningSection } from '../features/identity/Provisioning';
import { AppsSection } from '../features/apps/AppsSection';
import { TRIAGE_RUNGS } from '../features/projects/triage';
import { PeopleAtProviders } from '../features/vcs/People';
import { formatDate, formatItems, formatList, t, tr } from '../i18n';
import type { ReactNode } from 'react';

const ROLE_WORDS: Record<Role, string> = {
  admin: t('page.admin.anAdministratorChangesEverything'),
  member: t('page.admin.aMemberReadsAndChanges'),
  viewer: t('page.admin.aViewerReads'),
};
const ROLE_NAMES: Record<Role, string> = { admin: t('page.admin.administrator'), member: t('page.admin.member'), viewer: t('page.admin.viewer') };

function num(v: string): number | null {
  if (v.trim() === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

type SignInWays = { sso: { name: string } | null; passwords: boolean };

/** How someone signs in, in words: "Password", "Corp ID", "Password and Corp ID". */
function signsInWith(user: User, ways: SignInWays): { words: string; about: string | null } {
  if (user.isBot) return { words: t('page.admin.tokensOnly'), about: null };
  // Passkeys alone (D68): their passkeys, or the link that adds the first.
  if (user.signIn?.passkeysOnly) {
    const n = user.signIn.passkeys ?? 0;
    const until = user.signIn.passkeySetupUntil;
    return {
      words: t('page.admin.passkeysAlone'),
      about: n ? t('page.admin.withPasskeys', { n }) : until ? t('page.admin.linkRunsOut', { when: untilSaid(until) }) : t('page.admin.noPasskeyYet'),
    };
  }
  const providers = [...new Set((user.signIn?.identities ?? []).map((i) => i.provider))];
  const now = [...(user.signIn?.password && ways.passwords ? [t('page.admin.password')] : []), ...providers];
  const last = [...(user.signIn?.identities ?? []).map((i) => i.lastSignInAt), user.signIn?.lastSignInAt].filter((t): t is string => Boolean(t)).sort().at(-1);
  // Two-factor, passkeys and provisioning (D38, D62) say how, beside where.
  const also = [
    user.signIn?.twoFactor ? t('page.admin.withTwoFactor') : null,
    user.signIn?.passkeys ? t('page.admin.withPasskeys', { n: user.signIn.passkeys }) : null,
    user.signIn?.passkeyExempt ? t('page.admin.letOffPasskeys') : null,
    user.signIn?.provisioned ? t('page.admin.provisioned') : null,
    last ? t('page.admin.last', { when: agoSaid(last) }) : null,
  ].filter(Boolean);
  if (now.length) return { words: formatList(now), about: also.length ? also.join(' · ') : null };
  if (ways.sso && user.email && user.signIn?.emailConfirmed) return { words: t('page.admin.notYet'), about: t('page.admin.findsThemByEmail', { name: ways.sso.name }) };
  if (ways.sso && user.email) return { words: t('page.admin.notYet'), about: t('page.admin.onceTheirEmailIsConfirmed') };
  return { words: t('page.admin.canTYet'), about: ways.sso ? t('page.admin.giveThemAPasswordOr') : t('page.admin.giveThemAPassword') };
}

/** A link to add a passkey, shown once to hand over (D68): mailed ones aren't shown. */
function ShownLink({ url, name }: { url: string; name: string }) {
  return (
    <span className="item-about">
      {t('page.admin.giveThemThisLink', { name })} <output className="mono">{url}</output>
    </span>
  );
}

function PersonRow({ user, isMe, ways, required }: { user: User; isMe: boolean; ways: SignInWays; required: boolean }) {
  const qc = useQueryClient();
  const [shown, setShown] = useState<string | null>(null);
  // Passkeys alone (D68): a link adds their first passkey, or one in place of those lost.
  const link = useMutation({
    mutationFn: () => post<PasskeySetupLink>(`/users/${user.id}/passkey-setup`, {}),
    onSuccess: (l) => {
      setShown(l.url);
      setSaid(l.mailed ? { text: t('page.admin.linkMailed', { name: user.name }) } : null);
      void qc.invalidateQueries({ queryKey: keys.users });
    },
    onError: (e) => setSaid({ text: errorText(e), bad: true }),
  });
  // Where passkeys are required: let them sign in with a password and a code instead, or take that back.
  const exempt = useMutation({
    mutationFn: (on: boolean) => patch<User>(`/users/${user.id}`, { passkeyExempt: on }),
    onSuccess: (_u, on) => {
      setSaid({ text: on ? t('page.admin.letOffSaid', { name: user.name }) : t('page.admin.askedAgainSaid', { name: user.name }) });
      void qc.invalidateQueries({ queryKey: keys.users });
    },
    onError: (e) => setSaid({ text: errorText(e), bad: true }),
  });
  const initial = {
    name: user.name,
    email: user.email ?? '',
    role: user.role,
    banned: user.banned,
    hourlyRate: user.hourlyRate === null ? '' : String(user.hourlyRate),
    capacity: String(user.capacityHoursPerDay),
  };
  const [form, setForm] = useState(initial);
  const [said, setSaid] = useState<{ text: string; bad?: boolean } | null>(null);
  const savedKey = JSON.stringify(initial);
  useEffect(() => setForm(JSON.parse(savedKey) as typeof initial), [savedKey]);
  const dirty = JSON.stringify(form) !== savedKey;
  const save = useMutation({
    mutationFn: () =>
      patch<User>(`/users/${user.id}`, {
        name: form.name.trim(),
        email: form.email.trim() || null,
        ...(isMe ? {} : { role: form.role, banned: form.banned }),
        hourlyRate: num(form.hourlyRate),
        capacityHoursPerDay: num(form.capacity) ?? 0,
      }),
    onSuccess: () => {
      setSaid({ text: t('page.admin.saved') });
      void qc.invalidateQueries({ queryKey: keys.users });
      void qc.invalidateQueries({ queryKey: ['plan'] });
      void qc.invalidateQueries({ queryKey: ['projects'] });
      if (isMe) void qc.invalidateQueries({ queryKey: keys.me });
    },
    onError: (e) => setSaid({ text: errorText(e), bad: true }),
  });
  const label = (what: string) => t('page.admin.of', { what: what, name: user.name });
  const how = signsInWith(user, ways);
  // An email people set for themselves isn't one single sign-on may find them by, until an administrator confirms it.
  const unconfirmed = Boolean(user.email) && user.signIn !== undefined && !user.signIn.emailConfirmed && form.email.trim() === (user.email ?? '');
  const reset = useMutation({
    mutationFn: () => del(`/users/${user.id}/two-factor`),
    onSuccess: () => {
      setSaid({ text: t('page.admin.sTwoFactorSignIn', { name: user.name }) });
      void qc.invalidateQueries({ queryKey: keys.users });
    },
    onError: (e) => setSaid({ text: errorText(e), bad: true }),
  });
  const unpasskey = useMutation({
    mutationFn: () => del(`/users/${user.id}/passkeys`),
    onSuccess: () => {
      setSaid({ text: t('page.admin.passkeysRemoved', { name: user.name }) });
      void qc.invalidateQueries({ queryKey: keys.users });
    },
    onError: (e) => setSaid({ text: errorText(e), bad: true }),
  });
  const confirm = useMutation({
    mutationFn: () => patch<User>(`/users/${user.id}`, { email: user.email }),
    onSuccess: () => {
      setSaid({ text: t('page.admin.sEmailIsConfirmed', { name: user.name }) });
      void qc.invalidateQueries({ queryKey: keys.users });
    },
    onError: (e) => setSaid({ text: errorText(e), bad: true }),
  });
  return (
    <tr className={form.banned ? 'dimmed' : undefined}>
      <th scope="row" className="row-head">
        <span className="tw:flex tw:min-w-48 tw:items-center tw:gap-2">
          <Avatar kind={user.isBot ? 'agent' : 'person'} name={user.name} small />
          <span>
            <input
              value={form.name}
              onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
              aria-label={label(t('page.admin.name'))}
              maxLength={100}
              required
              className="tw:w-44"
            />
            <span className="item-about">
              <span className="mono">{user.login}</span>
              {user.isBot ? (
                <>
                  {' '}
                  · <span className="chip">{t('page.admin.bot')}</span>
                </>
              ) : null}
              {isMe ? t('page.admin.you') : ''}
            </span>
          </span>
        </span>
      </th>
      <td>
        <input
          type="email"
          value={form.email}
          onChange={(e) => setForm((f) => ({ ...f, email: e.target.value }))}
          aria-label={label(t('page.admin.email'))}
          placeholder={t('page.admin.none')}
          className="tw:w-48"
        />
        {unconfirmed ? (
          <span className="item-about">{tr('page.admin.notConfirmedSingleSignOn', { el: <button type="button" className="link" onClick={() => confirm.mutate()} disabled={confirm.isPending}>{t('page.admin.confirmIt')}</button> })}</span>
        ) : null}
      </td>
      <td>
        <span className="tw:block tw:min-w-36">
          {how.words}
          {how.about ? <span className="item-about">{how.about}</span> : null}
          {user.signIn?.twoFactor && !isMe ? (
            <button type="button" className="link" onClick={() => reset.mutate()} disabled={reset.isPending} aria-label={t('page.admin.resetTwoFactorFor', { name: user.name })}>{t('page.admin.resetTwoFactor')}</button>
          ) : null}
          {user.signIn?.passkeys && !isMe ? (
            <button type="button" className="link" onClick={() => unpasskey.mutate()} disabled={unpasskey.isPending} aria-label={t('page.admin.removePasskeysOf', { name: user.name })}>{t('page.admin.removePasskeys')}</button>
          ) : null}
          {user.signIn?.passkeysOnly && !isMe ? (
            <button type="button" className="link" onClick={() => link.mutate()} disabled={link.isPending} aria-label={t('page.admin.sendALinkTo', { name: user.name })}>{t('page.admin.sendALink')}</button>
          ) : null}
          {required && user.signIn?.password && !user.isBot ? (
            user.signIn.passkeyExempt ? (
              <button type="button" className="link" onClick={() => exempt.mutate(false)} disabled={exempt.isPending} aria-label={t('page.admin.askForAPasskeyOf', { name: user.name })}>{t('page.admin.askForAPasskey')}</button>
            ) : (
              <button type="button" className="link" onClick={() => exempt.mutate(true)} disabled={exempt.isPending} aria-label={t('page.admin.letOffFor', { name: user.name })}>{t('page.admin.letOff')}</button>
            )
          ) : null}
          {shown ? <ShownLink url={shown} name={user.name} /> : null}
        </span>
      </td>
      <td>
        <select value={form.role} onChange={(e) => setForm((f) => ({ ...f, role: e.target.value as Role }))} aria-label={label(t('page.admin.role'))} disabled={isMe}>
          {ROLES.map((r) => (
            <option key={r} value={r}>
              {r}
            </option>
          ))}
        </select>
      </td>
      <td>
        <input
          type="number"
          min={0}
          step="any"
          value={form.hourlyRate}
          onChange={(e) => setForm((f) => ({ ...f, hourlyRate: e.target.value }))}
          aria-label={label(t('page.admin.ratePerHour'))}
          placeholder={t('page.admin.none')}
          className="tw:w-26"
        />
      </td>
      <td>
        <input
          type="number"
          min={0}
          max={24}
          step={0.5}
          value={form.capacity}
          onChange={(e) => setForm((f) => ({ ...f, capacity: e.target.value }))}
          aria-label={label(t('page.admin.hoursADay'))}
          className="tw:w-26"
        />
      </td>
      <td>
        <label className="choice">
          <input
            type="checkbox"
            checked={!form.banned}
            onChange={(e) => setForm((f) => ({ ...f, banned: !e.target.checked }))}
            disabled={isMe}
            aria-label={t('page.admin.isAllowedIn', { name: user.name })}
          />
          <span aria-hidden="true">{form.banned ? t('page.admin.banned') : t('page.admin.allowed')}</span>
        </label>
      </td>
      <td className="fit">
        <button type="button" className="small" disabled={!dirty || !form.name.trim() || save.isPending} onClick={() => save.mutate()}>
          {save.isPending ? t('page.admin.saving') : t('page.admin.save')}
        </button>
        <Said text={said?.text} tone={said?.bad ? 'bad' : undefined} />
      </td>
    </tr>
  );
}

function AddPerson() {
  const qc = useQueryClient();
  const blank = { login: '', name: '', email: '', password: '', role: 'member' as Role, isBot: false, passkeysOnly: false, hourlyRate: '', capacity: '8' };
  const [form, setForm] = useState(blank);
  const [said, setSaid] = useState<{ text: string; bad?: boolean } | null>(null);
  const [shown, setShown] = useState<{ url: string; name: string } | null>(null);
  const alone = form.passkeysOnly && !form.isBot;
  const add = useMutation({
    mutationFn: async () => {
      const u = await post<User>('/users', {
        login: form.login.trim(),
        name: form.name.trim(),
        email: form.email.trim() || null,
        ...(form.password && !alone ? { password: form.password } : {}),
        ...(alone ? { passkeysOnly: true } : {}),
        role: form.role,
        isBot: form.isBot,
        hourlyRate: num(form.hourlyRate),
        capacityHoursPerDay: num(form.capacity) ?? 8,
      });
      // With passkeys alone (D68), their first comes from a link: mailed where it can be, else shown.
      return { u, link: alone ? await post<PasskeySetupLink>(`/users/${u.id}/passkey-setup`, {}) : null };
    },
    onSuccess: ({ u, link }) => {
      setShown(link?.url ? { url: link.url, name: u.name } : null);
      setSaid({
        text: u.isBot
          ? t('page.admin.isAddedAsABot', { login: u.login })
          : link
            ? link.mailed
              ? t('page.admin.addedLinkMailed', { name: u.name, login: u.login })
              : t('page.admin.addedLinkShown', { name: u.name, login: u.login })
            : t('page.admin.isAddedAndCanSign', { name: u.name, login: u.login }),
      });
      setForm(blank);
      void qc.invalidateQueries({ queryKey: keys.users });
    },
    onError: (e) => setSaid({ text: errorText(e), bad: true }),
  });
  const set = (k: keyof typeof blank) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
    setForm((f) => ({ ...f, [k]: e.target.type === 'checkbox' ? (e.target as HTMLInputElement).checked : e.target.value }));
  return (
    <form
      className="stack"
      onSubmit={(e) => {
        e.preventDefault();
        add.mutate();
      }}
    >
      <fieldset className="form-card adding stack">
        <legend>{t('page.admin.addSomeone')}</legend>
        <div className="form-fields">
          <FormField label={t('page.admin.name')}>{(id) => <input id={id} value={form.name} onChange={set('name')} required maxLength={100} />}</FormField>
          <FormField label={t('page.admin.login')}>
            {(id) => (
              <input
                id={id}
                value={form.login}
                onChange={set('login')}
                required
                minLength={2}
                maxLength={40}
                pattern="[a-zA-Z0-9._\-]+"
                className="mono"
                autoComplete="off"
              />
            )}
          </FormField>
          <FormField label={t('page.admin.email')}>{(id) => <input id={id} type="email" value={form.email} onChange={set('email')} />}</FormField>
          <FormField
            label={t('page.admin.password')}
            help={form.isBot ? t('page.admin.aBotDoesnTSign') : t('page.admin.atLeast8CharactersThey')}
          >
            {(id, help) => (
              <input
                id={id}
                aria-describedby={help}
                type="password"
                value={form.password}
                onChange={set('password')}
                minLength={8}
                autoComplete="new-password"
                required={!form.isBot && !alone}
                disabled={alone}
              />
            )}
          </FormField>
          <label className="choice">
            <input type="checkbox" checked={form.passkeysOnly} onChange={set('passkeysOnly')} disabled={form.isBot} />
            <span>{t('page.admin.passkeysAloneChoice')}</span>
          </label>
          <FormField label={t('page.admin.role')}>
            {(id) => (
              <select id={id} value={form.role} onChange={set('role')}>
                {ROLES.map((r) => (
                  <option key={r} value={r}>
                    {ROLE_NAMES[r]}
                  </option>
                ))}
              </select>
            )}
          </FormField>
          <FormField label={t('page.admin.ratePerHour')}>
            {(id) => <input id={id} type="number" min={0} step="any" value={form.hourlyRate} onChange={set('hourlyRate')} />}
          </FormField>
          <FormField label={t('page.admin.hoursADay')}>
            {(id) => <input id={id} type="number" min={0} max={24} step={0.5} value={form.capacity} onChange={set('capacity')} />}
          </FormField>
          <label className="choice">
            <input type="checkbox" checked={form.isBot} onChange={set('isBot')} />
            <span>{tr('page.admin.aBotAnAccountFor', { t0: (c: ReactNode) => <small className="field-help">{c}</small> })}</span>
          </label>
        </div>
        <div className="cluster">
          <button type="submit" className="primary" disabled={add.isPending}>
            {add.isPending ? t('page.admin.adding') : t('page.admin.addThem')}
          </button>
          <Said text={said?.text} tone={said?.bad ? 'bad' : undefined} />
        </div>
        {shown ? <ShownLink url={shown.url} name={shown.name} /> : null}
      </fieldset>
    </form>
  );
}

const REQUIRED_WORDS: Record<PasskeysRequired, string> = { off: 'page.admin.requireOfNobody', everyone: 'page.admin.requireOfEveryone', admins: 'page.admin.requireOfAdmins' };

/** FIDO's metadata as a4a last read it (D68): how old, the last try, and reading it again. */
function MetadataStatus() {
  const qc = useQueryClient();
  const meta = useQuery({ queryKey: ['passkey-metadata'], queryFn: () => get<PasskeyMetadata>('/passkey-metadata') });
  const again = useMutation({
    mutationFn: () => post<PasskeyMetadata>('/passkey-metadata/refresh'),
    onSuccess: (m) => qc.setQueryData(['passkey-metadata'], m),
  });
  if (meta.isLoading) return <Loading what="loadingLine.settings" />;
  if (meta.error || !meta.data) return <ErrorNote error={meta.error} />;
  const m = meta.data;
  return (
    <div className="stack">
      <p className="note">{m.no === null || !m.gotAt ? t('page.admin.metadataNone') : t('page.admin.metadataInUse', { no: m.no, when: agoSaid(m.gotAt) })}</p>
      {m.stale && m.nextUpdate ? <p className="note">{t('page.admin.metadataStale', { date: formatDate(m.nextUpdate, { dateStyle: 'medium' }) })}</p> : null}
      {m.failedAt && m.failure ? <p className="note">{t('page.admin.metadataFailed', { when: agoSaid(m.failedAt), failure: m.failure })}</p> : null}
      {m.failedAt && m.failureDetail ? <p className="note mono">{m.failureDetail}</p> : null}
      <p className="note">{t('page.admin.metadataFrom', { from: m.from })}</p>
      <div className="cluster">
        <button type="button" className="small" onClick={() => again.mutate()} disabled={again.isPending}>
          {again.isPending ? t('page.admin.reading') : t('page.admin.readItAgain')}
        </button>
      </div>
      {again.error ? <ErrorNote error={again.error} /> : null}
    </div>
  );
}

/** Only some authenticators (D68): chosen from what FIDO's metadata describes, and saved as a list. */
function Authenticators({ chosen, busy, onSave }: { chosen: string[] | null; busy: boolean; onSave: (list: string[] | null) => void }) {
  const meta = useQuery({ queryKey: ['passkey-metadata'], queryFn: () => get<PasskeyMetadata>('/passkey-metadata') });
  const [on, setOn] = useState(Boolean(chosen?.length));
  const [picked, setPicked] = useState<string[]>(chosen ?? []);
  const [find, setFind] = useState('');
  const known = meta.data?.authenticators ?? [];
  const q = find.trim().toLowerCase();
  // What's chosen first, then what the search finds: fifty at a time, as FIDO describes hundreds.
  const matches = known.filter((a) => picked.includes(a.aaguid) || !q || a.name.toLowerCase().includes(q) || a.aaguid.includes(q));
  const listed = matches.slice(0, 50);
  const toggle = (id: string, yes: boolean) => setPicked((p) => (yes ? [...new Set([...p, id])] : p.filter((x) => x !== id)));
  const dirty = on !== Boolean(chosen?.length) || (on && JSON.stringify([...picked].sort()) !== JSON.stringify([...(chosen ?? [])].sort()));
  return (
    <fieldset className="stack">
      <legend>{t('page.admin.onlySomeAuthenticators')}</legend>
      <label className="choice">
        <input type="checkbox" checked={on} onChange={(e) => setOn(e.target.checked)} />
        <span>{t('page.admin.takeOnlySome')}</span>
      </label>
      <p className="note">{t('page.admin.attestationPrivacy')}</p>
      {on ? (
        <>
          <MetadataStatus />
          {known.length ? (
            <>
              <FormField label={t('page.admin.findAnAuthenticator')}>{(id) => <input id={id} type="search" value={find} onChange={(e) => setFind(e.target.value)} />}</FormField>
              <ul className="stack" aria-label={t('page.admin.authenticatorsToChoose')}>
                {listed.map((a) => (
                  <li key={a.aaguid}>
                    <label className="choice">
                      <input type="checkbox" checked={picked.includes(a.aaguid)} disabled={a.revoked && !picked.includes(a.aaguid)} onChange={(e) => toggle(a.aaguid, e.target.checked)} />
                      <span>
                        {a.name} {a.revoked ? <Badge tone="bad">{t('page.admin.revoked')}</Badge> : null}
                      </span>
                    </label>
                  </li>
                ))}
              </ul>
              {matches.length > listed.length ? <p className="note">{t('page.admin.moreAuthenticators', { n: matches.length - listed.length })}</p> : null}
            </>
          ) : null}
          <p className="note">{t('page.admin.authenticatorsChosen', { n: picked.length })}</p>
        </>
      ) : null}
      <div className="cluster">
        <button type="button" disabled={busy || !dirty || (on && !picked.length)} onClick={() => onSave(on ? picked : null)}>
          {t('page.admin.saveAuthenticators')}
        </button>
      </div>
    </fieldset>
  );
}

function Instance({ settings }: { settings: Settings }) {
  const qc = useQueryClient();
  const [name, setName] = useState(settings.instanceName);
  const [said, setSaid] = useState<{ text: string; bad?: boolean } | null>(null);
  useEffect(() => setName(settings.instanceName), [settings.instanceName]);
  const save = useMutation({
    mutationFn: (body: { instanceName?: string; defaultTriageMode?: TriageMode; requireTwoFactor?: boolean; passkeys?: boolean; requirePasskeys?: PasskeysRequired; passkeyAuthenticators?: string[] | null }) =>
      patch<Settings>('/settings', body),
    onSuccess: (s, body) => {
      qc.setQueryData(keys.settings, s);
      void qc.invalidateQueries({ queryKey: keys.setup });
      setSaid({
        text: body.defaultTriageMode
          ? t('page.admin.newProjectsStartAtThat')
          : body.requireTwoFactor !== undefined
            ? body.requireTwoFactor
              ? t('page.admin.fromTheNextSignIn')
              : t('page.admin.twoFactorSignInIs')
            : body.passkeys !== undefined
              ? body.passkeys
                ? t('page.admin.passkeysOn')
                : t('page.admin.passkeysOff')
              : body.requirePasskeys !== undefined
                ? t('page.admin.requiredSaved', { whom: body.requirePasskeys })
                : body.passkeyAuthenticators !== undefined
                  ? t('page.admin.authenticatorsSaved', { on: body.passkeyAuthenticators?.length ? 'yes' : 'no' })
                  : t('page.admin.saved'),
      });
    },
    onError: (e) => setSaid({ text: errorText(e), bad: true }),
  });
  return (
    <div className="stack">
      <form
        className="form-fields"
        onSubmit={(e) => {
          e.preventDefault();
          save.mutate({ instanceName: name.trim() });
        }}
      >
        <FormField label={t('page.admin.itsName')} help={t('page.admin.shownWhenPeopleSignIn')}>
          {(id, help) => <input id={id} aria-describedby={help} value={name} onChange={(e) => setName(e.target.value)} required maxLength={80} />}
        </FormField>
        <FormField label={t('page.admin.itsAddress')} help={t('page.admin.linksInWebhooksAndFor')}>
          {(id, help) => (
            <output id={id} aria-describedby={help} className="mono">
              {settings.publicUrl}
            </output>
          )}
        </FormField>
        <div className="cluster tw:col-span-full">
          <button type="submit" disabled={name.trim() === settings.instanceName || !name.trim() || save.isPending}>{t('page.admin.saveTheName')}</button>
        </div>
      </form>
      <LadderChoice
        legend={t('page.admin.howFarTriageMayGo')}
        rungs={TRIAGE_RUNGS}
        value={save.isPending && save.variables?.defaultTriageMode ? save.variables.defaultTriageMode : settings.defaultTriageMode}
        onChange={save.isPending ? undefined : (m) => save.mutate({ defaultTriageMode: m })}
        note={t('page.admin.eachProjectCanChangeIt')}
      />
      <label className="choice">
        <input
          type="checkbox"
          checked={save.isPending && save.variables?.requireTwoFactor !== undefined ? save.variables.requireTwoFactor : Boolean(settings.requireTwoFactor)}
          onChange={(e) => save.mutate({ requireTwoFactor: e.target.checked })}
          disabled={save.isPending}
        />
        <span>{t('page.admin.askEveryoneWhoSignsIn')}</span>
      </label>
      <label className="choice">
        <input
          type="checkbox"
          checked={save.isPending && save.variables?.passkeys !== undefined ? save.variables.passkeys : settings.passkeys !== false}
          onChange={(e) => save.mutate({ passkeys: e.target.checked })}
          disabled={save.isPending}
        />
        <span>{t('page.admin.letPeopleUsePasskeys')}</span>
      </label>
      <fieldset className="stack">
        <legend>{t('page.admin.requireAPasskey')}</legend>
        {PASSKEYS_REQUIRED.map((r) => (
          <label key={r} className="choice">
            <input
              type="radio"
              name="require-passkeys"
              value={r}
              checked={(save.isPending && save.variables?.requirePasskeys ? save.variables.requirePasskeys : (settings.requirePasskeys ?? 'off')) === r}
              onChange={() => save.mutate({ requirePasskeys: r })}
              disabled={save.isPending || settings.passkeys === false}
            />
            <span>{t(REQUIRED_WORDS[r])}</span>
          </label>
        ))}
        <p className="note">{t('page.admin.requireNote')}</p>
      </fieldset>
      <Authenticators key={(settings.passkeyAuthenticators ?? []).join()} chosen={settings.passkeyAuthenticators ?? null} busy={save.isPending} onSave={(list) => save.mutate({ passkeyAuthenticators: list })} />
      <Said text={said?.text} tone={said?.bad ? 'bad' : undefined} />
    </div>
  );
}

/** The people who use a4a, what each may do, their rate and hours, and the instance's settings. */
export default function AdminPage() {
  const users = useUsers();
  const settings = useSettings();
  const me = useMe();
  const status = useSetupStatus();
  const ways: SignInWays = { sso: status.data?.signIn.sso ?? null, passwords: status.data?.signIn.password ?? true };
  const people = users.data ?? [];
  const banned = people.filter((u) => u.banned).length;
  const bots = people.filter((u) => u.isBot).length;
  const humans = people.length - bots;
  return (
    <AdminOnly title={t('page.admin.administration')}>
      <PageHead title={t('page.admin.administration')} about={t('page.admin.thePeopleWhoUseA4a')} />
      <section className="card" aria-labelledby="people">
        <div className="section-head">
          <h2 id="people">{t('page.admin.people')}</h2>
          <span className="note">
            {formatItems([t('count.people', { n: humans }), bots ? t('page.admin.bots', { n: bots }) : '', banned ? t('page.admin.banned2', { banned: banned }) : ''].filter(Boolean))}
          </span>
        </div>
        <p className="note section-note">{t('page.admin.aRateAndHoursA')}</p>
        {users.isLoading ? <Loading what="loadingLine.people" /> : null}
        {users.error ? <ErrorNote error={users.error} /> : null}
        {people.length ? (
          <Scroll label={t('page.admin.tableOfPeople')}>
            <table className="figures middle">
              <thead>
                <tr>
                  <th scope="col">{t('page.admin.person')}</th>
                  <th scope="col">{t('page.admin.email')}</th>
                  <th scope="col">{t('page.admin.signsInWith')}</th>
                  <th scope="col">{t('page.admin.role')}</th>
                  <th scope="col">{t('page.admin.ratePerHour')}</th>
                  <th scope="col">{t('page.admin.hoursADay')}</th>
                  <th scope="col">{t('page.admin.access')}</th>
                  <th scope="col">
                    <span className="hidden">{t('page.admin.save')}</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {people.map((u) => (
                  <PersonRow key={u.id} user={u} isMe={u.id === me.data?.id} ways={ways} required={(settings.data?.requirePasskeys ?? 'off') !== 'off'} />
                ))}
              </tbody>
            </table>
          </Scroll>
        ) : null}
        <p className="note">{tr('page.admin.rolesATokenNeverDoes', { join: formatList(ROLES.map((r) => ROLE_WORDS[r])) })}</p>
        <AddPerson />
      </section>
      <GroupsSection />
      <RolesSection />
      <ProvisioningSection />
      <AppsSection />
      <section className="card" aria-labelledby="vcs-people">
        <div className="section-head">
          <h2 id="vcs-people">{t('page.admin.whoWroteWhichCommits')}</h2>
          <span className="note">{t('page.admin.emailsAndLoginsAtVersion')}</span>
        </div>
        <PeopleAtProviders />
      </section>
      <section className="card" aria-labelledby="instance">
        <h2 id="instance">{t('page.admin.thisInstance')}</h2>
        {settings.isLoading ? <Loading what="loadingLine.settings" /> : null}
        {settings.error ? <ErrorNote error={settings.error} /> : null}
        {settings.data ? <Instance settings={settings.data} /> : null}
      </section>
    </AdminOnly>
  );
}

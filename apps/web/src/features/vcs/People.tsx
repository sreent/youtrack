import type { PersonEmails, ProviderLogin, User, UserEmail, VcsProvider } from '@a4a/shared';
import { VCS_PROVIDERS, VCS_PROVIDER_NAMES } from '@a4a/shared/constants';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { del, get, post } from '../../api/client';
import { keys, useMe, useUsers } from '../../api/queries';
import { ago, agoSaid, Badge } from '../../components/Badges';
import { ErrorNote, Loading } from '../../components/States';
import { errorText, FormField, Said, Scroll } from '../common/bits';
import { Confirm } from '../common/Confirm';
import { listNodes, t, tr } from '../../i18n';

export const emailKeys = {
  mine: ['me', 'emails'] as const,
  of: (id: string) => ['users', id, 'emails'] as const,
  logins: (id: string) => ['users', id, 'provider-logins'] as const,
};

type Outcome = { text: string; bad?: boolean } | null;

/** How an email stands, with its shape: confirmed went well; waiting waits on its person. */
function Stands({ email }: { email: UserEmail }) {
  return email.confirmed ? (
    <Badge tone="good">{t('vcs.people.confirmed')}</Badge>
  ) : (
    <>
      <Badge tone="warn">{t('vcs.people.waitingToBeConfirmed')}</Badge>
      {email.linkSentAt ? <span className="item-about">{tr('vcs.people.aLinkWent', { when: agoSaid(email.linkSentAt) })}</span> : null}
    </>
  );
}

/** What's known of an email, under it: primary, and who confirmed it. */
function about(email: UserEmail, meId: string | undefined): string {
  const parts = [email.primary ? t('vcs.people.primaryWhereA4aWrites') : null];
  if (email.confirmed && email.confirmedBy) parts.push((email.confirmedBy.id === meId ? t('vcs.people.confirmedByYou') : t('vcs.people.confirmedByName', { name: email.confirmedBy.name })));
  return parts.filter(Boolean).join(' · ');
}

/** Your emails, on your profile: each confirmed by a link a4a mails to it, and which is primary. */
export function YourEmails() {
  const qc = useQueryClient();
  const me = useMe();
  const emails = useQuery({ queryKey: emailKeys.mine, queryFn: () => get<PersonEmails>('/me/emails') });
  const meId = me.data?.id;
  const logins = useQuery({ queryKey: emailKeys.logins(meId ?? ''), queryFn: () => get<ProviderLogin[]>(`/users/${meId}/provider-logins`), enabled: Boolean(meId) });
  const [email, setEmail] = useState('');
  const [said, setSaid] = useState<Outcome>(null);
  const done =(data: PersonEmails, text: string) => {
    qc.setQueryData(emailKeys.mine, data);
    void qc.invalidateQueries({ queryKey: keys.me });
    void qc.invalidateQueries({ queryKey: keys.users });
    setSaid({ text });
  };
  const failed = (e: unknown) => setSaid({ text: errorText(e), bad: true });
  const add = useMutation({
    mutationFn: (e: string) => post<PersonEmails>('/me/emails', { email: e }),
    onSuccess: (data, e) => {
      setEmail('');
      done(data, data.canSendLinks ? t('vcs.people.aLinkWentToOpen', { e: e }) : t('vcs.people.isAddedA4aCanT', { e: e }));
    },
    onError: failed,
  });
  const send = useMutation({
    mutationFn: (e: string) => post<PersonEmails>('/me/emails/send', { email: e }),
    onSuccess: (data, e) => done(data, t('vcs.people.aNewLinkWentTo', { e: e })),
    onError: failed,
  });
  const primary = useMutation({
    mutationFn: (e: string) => post<PersonEmails>('/me/emails/primary', { email: e }),
    onSuccess: (data, e) => done(data, t('vcs.people.isYourPrimaryEmailNow', { e: e })),
    onError: failed,
  });
  const remove = useMutation({
    mutationFn: (e: UserEmail) => del(`/me/emails/${e.id}`),
    onSuccess: (_, e) => {
      void qc.invalidateQueries({ queryKey: emailKeys.mine });
      setSaid({ text: t('vcs.people.isRemovedCommitsUnderIt', { email: e.email }) });
    },
    onError: failed,
  });
  if (emails.isLoading) return <Loading what="loadingLine.yourEmails" />;
  if (emails.error) return <ErrorNote error={emails.error} />;
  const list = emails.data?.emails ?? [];
  const canSend = emails.data?.canSendLinks ?? false;
  const busy = send.isPending || primary.isPending || remove.isPending;
  return (
    <div className="stack">
      <p className="note section-note">{tr('vcs.people.commitsUnderAnyOfYour', { code: <code>BACK-12 #Fixed</code> })}</p>
      {list.length ? (
        <Scroll label={t('vcs.people.tableOfYourEmails')}>
          <table className="figures middle">
            <thead>
              <tr>
                <th scope="col">{t('vcs.people.email')}</th>
                <th scope="col">{t('vcs.people.howItStands')}</th>
                <th scope="col">
                  <span className="hidden">{t('vcs.people.whatYouCanDo')}</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {list.map((e) => (
                <tr key={e.id ?? 'primary'}>
                  <th scope="row" className="row-head">
                    <span className="item-name mono">{e.email}</span>
                    {about(e, meId) ? <span className="item-about">{about(e, meId)}</span> : null}
                  </th>
                  <td>
                    <Stands email={e} />
                  </td>
                  <td className="fit">
                    <span className="cluster">
                      {!e.confirmed && canSend ? (
                        <button type="button" className="small" disabled={busy} onClick={() => send.mutate(e.email)} aria-label={`${e.linkSentAt ? t('vcs.people.sendTheLinkAgain') : t('vcs.people.sendALink')}: ${e.email}`}>
                          {e.linkSentAt ? t('vcs.people.sendTheLinkAgain') : t('vcs.people.sendALink')}
                        </button>
                      ) : null}
                      {!e.primary && e.confirmed ? (
                        <button type="button" className="small" disabled={busy} onClick={() => primary.mutate(e.email)} aria-label={t('vcs.people.makeItPrimary', { email: e.email })}>{t('vcs.people.makeItPrimary2')}</button>
                      ) : null}
                      {e.id ? (
                        <Confirm
                          small
                          label={t('vcs.people.remove')}
                          name={t('vcs.people.remove3', { email: e.email })}
                          title={t('vcs.people.remove2', { email: e.email })}
                          about={t('vcs.people.commitsUnderItWonT')}
                          confirm={t('vcs.people.removeIt')}
                          disabled={busy}
                          onConfirm={() => remove.mutate(e)}
                        />
                      ) : null}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Scroll>
      ) : (
        <p className="note">{t('vcs.people.youHaveNoEmailIn')}</p>
      )}
      <form
        className="cluster"
        onSubmit={(ev) => {
          ev.preventDefault();
          if (email.trim()) add.mutate(email.trim());
        }}
      >
        <FormField label={t('vcs.people.addAnEmail')} className="inline">
          {(id) => <input id={id} type="email" value={email} onChange={(ev) => setEmail(ev.target.value)} autoComplete="email" required maxLength={254} />}
        </FormField>
        <button type="submit" disabled={!email.trim() || add.isPending}>
          {add.isPending ? t('vcs.people.adding') : t('vcs.people.addIt')}
        </button>
      </form>
      {!canSend ? <p className="note">{t('vcs.people.a4aCanTSendEmail')}</p> : null}
      <Said text={said?.text} tone={said?.bad ? 'bad' : undefined} />
      {logins.data?.length ? (
        <p className="note">
          {tr('vcs.people.versionControlKnowsYouByLogins', {
            n: logins.data.length,
            map: listNodes(
              logins.data.map((l) => (
                <span key={l.id}>
                  {VCS_PROVIDER_NAMES[l.provider]} <span className="mono">{l.login}</span>
                </span>
              )),
            ),
          })}
        </p>
      ) : null}
    </div>
  );
}

/** What a login looks like at each provider, as the field's help says. */
const LOGIN_HELP: Record<VcsProvider, { help: string; placeholder: string }> = {
  github: { help: t('vcs.people.theirGithubUsername'), placeholder: 'anna-s' },
  gitlab: { help: t('vcs.people.theirGitlabUsernameGitlabNames'), placeholder: 'anna.s' },
  bitbucket: { help: t('vcs.people.theirAccountIdOrUuid'), placeholder: '557058:…' },
  'bitbucket-dc': { help: t('vcs.people.theirBitbucketDataCenterUsername'), placeholder: 'anna' }, // not words: an example login
  gitea: { help: t('vcs.people.theirGiteaOrForgejoUsername'), placeholder: 'anna' }, // not words: an example login
};

/** One person's emails and logins, as an administrator sees and changes them. */
function PersonPanel({ person }: { person: User }) {
  const qc = useQueryClient();
  const emails = useQuery({ queryKey: emailKeys.of(person.id), queryFn: () => get<PersonEmails>(`/users/${person.id}/emails`) });
  const logins = useQuery({ queryKey: emailKeys.logins(person.id), queryFn: () => get<ProviderLogin[]>(`/users/${person.id}/provider-logins`) });
  const [email, setEmail] = useState('');
  const [provider, setProvider] = useState<VcsProvider>('github');
  const [login, setLogin] = useState('');
  const [said, setSaid] = useState<Outcome>(null);
  const failed = (e: unknown) => setSaid({ text: errorText(e), bad: true });
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: emailKeys.of(person.id) });
    void qc.invalidateQueries({ queryKey: emailKeys.logins(person.id) });
    void qc.invalidateQueries({ queryKey: keys.users });
  };
  const confirm = useMutation({
    mutationFn: (e: string) => post<PersonEmails>(`/users/${person.id}/emails`, { email: e }),
    onSuccess: (_, e) => {
      setEmail('');
      refresh();
      setSaid({ text: t('vcs.people.isSConfirmed', { e: e, name: person.name }) });
    },
    onError: failed,
  });
  const removeEmail = useMutation({
    mutationFn: (e: UserEmail) => del(`/users/${person.id}/emails/${e.id}`),
    onSuccess: (_, e) => {
      refresh();
      setSaid({ text: t('vcs.people.isNoLongerS', { email: e.email, name: person.name }) });
    },
    onError: failed,
  });
  const record = useMutation({
    mutationFn: () => post<ProviderLogin>(`/users/${person.id}/provider-logins`, { provider, login: login.trim() }),
    onSuccess: (l) => {
      setLogin('');
      refresh();
      setSaid({ text: t('vcs.people.isSLoginThereNow', { v: VCS_PROVIDER_NAMES[l.provider], login: l.login, name: person.name }) });
    },
    onError: failed,
  });
  const forget = useMutation({
    mutationFn: (l: ProviderLogin) => del(`/users/${person.id}/provider-logins/${l.id}`),
    onSuccess: (_, l) => {
      refresh();
      setSaid({ text: t('vcs.people.a4aNoLongerKnowsBy', { name: person.name, login: l.login, v: VCS_PROVIDER_NAMES[l.provider] }) });
    },
    onError: failed,
  });
  return (
    <div className="stack">
      <h3>{tr('vcs.people.emailsOf', { name: person.name })}</h3>
      {emails.isLoading ? <Loading what="loadingLine.theirEmails" /> : null}
      {emails.error ? <ErrorNote error={emails.error} /> : null}
      {emails.data && !emails.data.emails.length ? <p className="note">{t('vcs.people.noEmailYet')}</p> : null}
      {emails.data?.emails.length ? (
        <Scroll label={t('vcs.people.tableOfSEmails', { name: person.name })}>
          <table className="figures middle">
            <thead>
              <tr>
                <th scope="col">{t('vcs.people.email')}</th>
                <th scope="col">{t('vcs.people.howItStands')}</th>
                <th scope="col">
                  <span className="hidden">{t('vcs.people.whatYouCanDo')}</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {emails.data.emails.map((e) => (
                <tr key={e.id ?? 'primary'}>
                  <th scope="row" className="row-head">
                    <span className="item-name mono">{e.email}</span>
                    {about(e, undefined) ? <span className="item-about">{about(e, undefined)}</span> : null}
                  </th>
                  <td>
                    <Stands email={e} />
                  </td>
                  <td className="fit">
                    <span className="cluster">
                      {!e.confirmed ? (
                        <button type="button" className="small" disabled={confirm.isPending} onClick={() => confirm.mutate(e.email)} aria-label={t('vcs.people.confirmIt', { email: e.email })}>{t('vcs.people.confirmIt2')}</button>
                      ) : null}
                      {e.id ? (
                        <Confirm
                          small
                          label={t('vcs.people.remove')}
                          name={t('vcs.people.remove3', { email: e.email })}
                          title={t('vcs.people.removeFrom', { email: e.email, name: person.name })}
                          about={t('vcs.people.commitsUnderItWonT2')}
                          confirm={t('vcs.people.removeIt')}
                          disabled={removeEmail.isPending}
                          onConfirm={() => removeEmail.mutate(e)}
                        />
                      ) : null}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Scroll>
      ) : null}
      <form
        className="cluster"
        onSubmit={(ev) => {
          ev.preventDefault();
          if (email.trim()) confirm.mutate(email.trim());
        }}
      >
        <FormField label={t('vcs.people.addAnEmailOfS', { name: person.name })} className="inline">
          {(id) => <input id={id} type="email" value={email} onChange={(ev) => setEmail(ev.target.value)} required maxLength={254} />}
        </FormField>
        <button type="submit" disabled={!email.trim() || confirm.isPending}>{t('vcs.people.addIt')}</button>
      </form>

      <h3>{tr('vcs.people.loginsOf', { name: person.name })}</h3>
      {logins.isLoading ? <Loading what="loadingLine.theirLogins" /> : null}
      {logins.error ? <ErrorNote error={logins.error} /> : null}
      {logins.data && !logins.data.length ? <p className="note">{t('vcs.people.noneRecorded')}</p> : null}
      {logins.data?.length ? (
        <Scroll label={t('vcs.people.tableOfSLogins', { name: person.name })}>
          <table className="figures middle">
            <thead>
              <tr>
                <th scope="col">{t('vcs.people.at')}</th>
                <th scope="col">{t('vcs.people.login')}</th>
                <th scope="col">{t('vcs.people.recorded')}</th>
                <th scope="col">
                  <span className="hidden">{t('vcs.people.whatYouCanDo')}</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {logins.data.map((l) => (
                <tr key={l.id}>
                  <th scope="row" className="row-head">
                    <span className="item-name">{VCS_PROVIDER_NAMES[l.provider]}</span>
                  </th>
                  <td className="mono">{l.login}</td>
                  <td>
                    {l.addedBy ? t('vcs.people.by', { name: l.addedBy.name }) : ''}
                    {ago(l.createdAt)}
                  </td>
                  <td className="fit">
                    <Confirm
                      small
                      label={t('vcs.people.forgetIt')}
                      name={t('vcs.people.forgetItAt', { login: l.login, v: VCS_PROVIDER_NAMES[l.provider] })}
                      title={t('vcs.people.forgetSLoginAt', { name: person.name, login: l.login, v: VCS_PROVIDER_NAMES[l.provider] })}
                      about={t('vcs.people.commitsAndPullRequestsThat')}
                      confirm={t('vcs.people.forgetIt')}
                      disabled={forget.isPending}
                      onConfirm={() => forget.mutate(l)}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Scroll>
      ) : null}
      <form
        className="cluster"
        onSubmit={(ev) => {
          ev.preventDefault();
          if (login.trim()) record.mutate();
        }}
      >
        <FormField label={t('vcs.people.at')} className="inline">
          {(id) => (
            <select id={id} value={provider} onChange={(ev) => setProvider(ev.target.value as VcsProvider)}>
              {VCS_PROVIDERS.map((p) => (
                <option key={p} value={p}>
                  {VCS_PROVIDER_NAMES[p]}
                </option>
              ))}
            </select>
          )}
        </FormField>
        <FormField label={t('vcs.people.theirLoginThere')} className="inline" help={LOGIN_HELP[provider].help}>
          {(id, help) => (
            <input id={id} aria-describedby={help} value={login} onChange={(ev) => setLogin(ev.target.value)} required maxLength={200} placeholder={LOGIN_HELP[provider].placeholder} className="mono" />
          )}
        </FormField>
        <button type="submit" disabled={!login.trim() || record.isPending}>{t('vcs.people.recordIt')}</button>
      </form>
      <Said text={said?.text} tone={said?.bad ? 'bad' : undefined} />
    </div>
  );
}

/** Administration's view of who's who in version control: a person's emails and logins. */
export function PeopleAtProviders() {
  const users = useUsers();
  const people = (users.data ?? []).filter((u) => !u.isBot);
  const [who, setWho] = useState('');
  const person = people.find((p) => p.id === who) ?? null;
  return (
    <div className="stack">
      <p className="note section-note">{t('vcs.people.aCommitIsItsAuthor')}</p>
      <FormField label={t('vcs.people.whose')} className="inline">
        {(id) => (
          <select id={id} value={who} onChange={(e) => setWho(e.target.value)}>
            <option value="">{t('vcs.people.chooseSomeone')}</option>
            {people.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name} ({p.login})
              </option>
            ))}
          </select>
        )}
      </FormField>
      {person ? <PersonPanel key={person.id} person={person} /> : null}
    </div>
  );
}

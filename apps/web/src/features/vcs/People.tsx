import type { PersonEmails, ProviderLogin, User, UserEmail, VcsProvider } from '@a4a/shared';
import { VCS_PROVIDERS, VCS_PROVIDER_NAMES } from '@a4a/shared/constants';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { del, get, post } from '../../api/client';
import { keys, useMe, useUsers } from '../../api/queries';
import { ago, Badge } from '../../components/Badges';
import { ErrorNote, Loading } from '../../components/States';
import { errorText, FormField, Said, Scroll } from '../common/bits';
import { Confirm } from '../common/Confirm';

export const emailKeys = {
  mine: ['me', 'emails'] as const,
  of: (id: string) => ['users', id, 'emails'] as const,
  logins: (id: string) => ['users', id, 'provider-logins'] as const,
};

type Outcome = { text: string; bad?: boolean } | null;

/** How an email stands, with its shape: confirmed went well; waiting waits on its person. */
function Stands({ email }: { email: UserEmail }) {
  return email.confirmed ? (
    <Badge tone="good">confirmed</Badge>
  ) : (
    <>
      <Badge tone="warn">waiting to be confirmed</Badge>
      {email.linkSentAt ? <span className="item-about">a link went {ago(email.linkSentAt)}</span> : null}
    </>
  );
}

/** What's known of an email, under it: primary, and who confirmed it. */
function about(email: UserEmail, meId: string | undefined): string {
  const parts = [email.primary ? 'primary: where a4a writes' : null];
  if (email.confirmed && email.confirmedBy) parts.push(`confirmed by ${email.confirmedBy.id === meId ? 'you' : email.confirmedBy.name}`);
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
      done(data, data.canSendLinks ? `A link went to ${e}: open it, signed in as you, to confirm it.` : `${e} is added. a4a can't send email here, so an administrator confirms it.`);
    },
    onError: failed,
  });
  const send = useMutation({
    mutationFn: (e: string) => post<PersonEmails>('/me/emails/send', { email: e }),
    onSuccess: (data, e) => done(data, `A new link went to ${e}.`),
    onError: failed,
  });
  const primary = useMutation({
    mutationFn: (e: string) => post<PersonEmails>('/me/emails/primary', { email: e }),
    onSuccess: (data, e) => done(data, `${e} is your primary email now.`),
    onError: failed,
  });
  const remove = useMutation({
    mutationFn: (e: UserEmail) => del(`/me/emails/${e.id}`),
    onSuccess: (_, e) => {
      void qc.invalidateQueries({ queryKey: emailKeys.mine });
      setSaid({ text: `${e.email} is removed: commits under it aren't yours from now on.` });
    },
    onError: failed,
  });
  if (emails.isLoading) return <Loading what="your emails" />;
  if (emails.error) return <ErrorNote error={emails.error} />;
  const list = emails.data?.emails ?? [];
  const canSend = emails.data?.canSendLinks ?? false;
  const busy = send.isPending || primary.isPending || remove.isPending;
  return (
    <div className="stack">
      <p className="note section-note">
        Commits under any of your confirmed emails are yours: they link to issues as yours, and the commands in them, such as <code>BACK-12 #Fixed</code>, run as you.
      </p>
      {list.length ? (
        <Scroll label="Table of your emails">
          <table className="figures middle">
            <thead>
              <tr>
                <th scope="col">Email</th>
                <th scope="col">How it stands</th>
                <th scope="col">
                  <span className="hidden">What you can do</span>
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
                        <button type="button" className="small" disabled={busy} onClick={() => send.mutate(e.email)} aria-label={`${e.linkSentAt ? 'Send the link again' : 'Send a link'}: ${e.email}`}>
                          {e.linkSentAt ? 'Send the link again' : 'Send a link'}
                        </button>
                      ) : null}
                      {!e.primary && e.confirmed ? (
                        <button type="button" className="small" disabled={busy} onClick={() => primary.mutate(e.email)} aria-label={`Make it primary: ${e.email}`}>
                          Make it primary
                        </button>
                      ) : null}
                      {e.id ? (
                        <Confirm
                          small
                          label="Remove"
                          name={`Remove ${e.email}`}
                          title={`Remove ${e.email}?`}
                          about="Commits under it won't be yours from now on. Those linked already stay as they are."
                          confirm="Remove it"
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
        <p className="note">You have no email in a4a yet.</p>
      )}
      <form
        className="cluster"
        onSubmit={(ev) => {
          ev.preventDefault();
          if (email.trim()) add.mutate(email.trim());
        }}
      >
        <FormField label="Add an email" className="inline">
          {(id) => <input id={id} type="email" value={email} onChange={(ev) => setEmail(ev.target.value)} autoComplete="email" required maxLength={254} />}
        </FormField>
        <button type="submit" disabled={!email.trim() || add.isPending}>
          {add.isPending ? 'Adding…' : 'Add it'}
        </button>
      </form>
      {!canSend ? <p className="note">a4a can't send email here, so an administrator confirms emails, under Administration.</p> : null}
      <Said text={said?.text} tone={said?.bad ? 'bad' : undefined} />
      {logins.data?.length ? (
        <p className="note">
          Version control knows you by your login{logins.data.length > 1 ? 's' : ''} too:{' '}
          {logins.data.map((l, i) => (
            <span key={l.id}>
              {i ? ', ' : ''}
              {VCS_PROVIDER_NAMES[l.provider]} <span className="mono">{l.login}</span>
            </span>
          ))}
          . An administrator records these.
        </p>
      ) : null}
    </div>
  );
}

/** What a login looks like at each provider, as the field's help says. */
const LOGIN_HELP: Record<VcsProvider, { help: string; placeholder: string }> = {
  github: { help: 'Their GitHub username.', placeholder: 'anna-s' },
  gitlab: { help: "Their GitLab username. GitLab names it for merge requests; a commit's author it knows by email only.", placeholder: 'anna.s' },
  bitbucket: { help: "Their account id or UUID, from their Bitbucket profile: nicknames aren't unique.", placeholder: '557058:…' },
  'bitbucket-dc': { help: 'Their Bitbucket Data Center username.', placeholder: 'anna' },
  gitea: { help: 'Their Gitea or Forgejo username.', placeholder: 'anna' },
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
      setSaid({ text: `${e} is ${person.name}'s, confirmed.` });
    },
    onError: failed,
  });
  const removeEmail = useMutation({
    mutationFn: (e: UserEmail) => del(`/users/${person.id}/emails/${e.id}`),
    onSuccess: (_, e) => {
      refresh();
      setSaid({ text: `${e.email} is no longer ${person.name}'s.` });
    },
    onError: failed,
  });
  const record = useMutation({
    mutationFn: () => post<ProviderLogin>(`/users/${person.id}/provider-logins`, { provider, login: login.trim() }),
    onSuccess: (l) => {
      setLogin('');
      refresh();
      setSaid({ text: `${VCS_PROVIDER_NAMES[l.provider]} ${l.login} is ${person.name}'s login there now.` });
    },
    onError: failed,
  });
  const forget = useMutation({
    mutationFn: (l: ProviderLogin) => del(`/users/${person.id}/provider-logins/${l.id}`),
    onSuccess: (_, l) => {
      refresh();
      setSaid({ text: `a4a no longer knows ${person.name} by ${l.login} at ${VCS_PROVIDER_NAMES[l.provider]}.` });
    },
    onError: failed,
  });
  return (
    <div className="stack">
      <h3>Emails of {person.name}</h3>
      {emails.isLoading ? <Loading what="their emails" /> : null}
      {emails.error ? <ErrorNote error={emails.error} /> : null}
      {emails.data && !emails.data.emails.length ? <p className="note">No email yet.</p> : null}
      {emails.data?.emails.length ? (
        <Scroll label={`Table of ${person.name}'s emails`}>
          <table className="figures middle">
            <thead>
              <tr>
                <th scope="col">Email</th>
                <th scope="col">How it stands</th>
                <th scope="col">
                  <span className="hidden">What you can do</span>
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
                        <button type="button" className="small" disabled={confirm.isPending} onClick={() => confirm.mutate(e.email)} aria-label={`Confirm it: ${e.email}`}>
                          Confirm it
                        </button>
                      ) : null}
                      {e.id ? (
                        <Confirm
                          small
                          label="Remove"
                          name={`Remove ${e.email}`}
                          title={`Remove ${e.email} from ${person.name}?`}
                          about="Commits under it won't be theirs from now on. Those linked already stay as they are."
                          confirm="Remove it"
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
        <FormField label={`Add an email of ${person.name}'s, confirmed`} className="inline">
          {(id) => <input id={id} type="email" value={email} onChange={(ev) => setEmail(ev.target.value)} required maxLength={254} />}
        </FormField>
        <button type="submit" disabled={!email.trim() || confirm.isPending}>
          Add it
        </button>
      </form>

      <h3>Logins of {person.name}</h3>
      {logins.isLoading ? <Loading what="their logins" /> : null}
      {logins.error ? <ErrorNote error={logins.error} /> : null}
      {logins.data && !logins.data.length ? <p className="note">None recorded.</p> : null}
      {logins.data?.length ? (
        <Scroll label={`Table of ${person.name}'s logins`}>
          <table className="figures middle">
            <thead>
              <tr>
                <th scope="col">At</th>
                <th scope="col">Login</th>
                <th scope="col">Recorded</th>
                <th scope="col">
                  <span className="hidden">What you can do</span>
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
                    {l.addedBy ? `by ${l.addedBy.name}, ` : ''}
                    {ago(l.createdAt)}
                  </td>
                  <td className="fit">
                    <Confirm
                      small
                      label="Forget it"
                      name={`Forget it: ${l.login} at ${VCS_PROVIDER_NAMES[l.provider]}`}
                      title={`Forget ${person.name}'s login ${l.login} at ${VCS_PROVIDER_NAMES[l.provider]}?`}
                      about="Commits and pull requests that provider names by it won't be theirs from now on."
                      confirm="Forget it"
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
        <FormField label="At" className="inline">
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
        <FormField label="Their login there" className="inline" help={LOGIN_HELP[provider].help}>
          {(id, help) => (
            <input id={id} aria-describedby={help} value={login} onChange={(ev) => setLogin(ev.target.value)} required maxLength={200} placeholder={LOGIN_HELP[provider].placeholder} className="mono" />
          )}
        </FormField>
        <button type="submit" disabled={!login.trim() || record.isPending}>
          Record it
        </button>
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
      <p className="note section-note">
        A commit is its author's when its email is one of theirs, confirmed, or when the provider names their login there: GitHub, Gitea and Bitbucket name the account they
        matched a commit's email to. People add and confirm their own emails on their profile; here you add one confirmed, and record their logins.
      </p>
      <FormField label="Whose" className="inline">
        {(id) => (
          <select id={id} value={who} onChange={(e) => setWho(e.target.value)}>
            <option value="">Choose someone</option>
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

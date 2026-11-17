import type { PortalDesk, PortalMe, PortalRequest, PortalRequestDetail } from '@a4a/shared';
import { HELP_LIMITS } from '@a4a/shared/constants';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { ApiError, get, patch, post } from '../api/client';
import { Lone } from '../app/Auth';
import { Badge } from '../components/Badges';
import { Markdown } from '../components/Markdown';
import { ErrorNote, Loading } from '../components/States';
import { Avatar, Who } from '../components/Who';
import { FormField } from '../features/common/bits';
import { whenRead } from '../features/common/format';
import { intlLocale, t, tr } from '../i18n';
import type { ReactNode } from 'react';

/** A sign-in link's token is in the fragment, which never leaves the browser: it's sent once, then dropped. */
function linkToken(): string {
  const t = window.location.hash.replace(/^#/, '').trim();
  return /^hdl_[A-Za-z0-9_-]{43}$/.test(t) ? t : '';
}

function SignIn() {
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const desk = new URLSearchParams(window.location.search).get('desk') ?? undefined;
  const send = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await post('/portal/sign-in', { email, desk });
      setSent(true);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Lone>
      <h1>{t('page.portal.yourRequests')}</h1>
      {sent ? (
        <p role="status">{tr('page.portal.ifCanSignInA', { email: email })}</p>
      ) : (
        <form className="form" onSubmit={send} aria-label={t('page.portal.signInWithYourEmail')}>
          <p className="note">{t('page.portal.weLlEmailYouA')}</p>
          <FormField label={t('page.portal.yourEmail')}>{(id) => <input id={id} type="email" required autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} />}</FormField>
          {error ? <ErrorNote error={error} /> : null}
          <div className="cluster end">
            <button type="submit" className="primary" disabled={busy || !email.trim()}>
              {busy ? t('page.portal.sending') : t('page.portal.emailMeALink')}
            </button>
          </div>
        </form>
      )}
    </Lone>
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
            <li key={c.email}>
              <Who kind="person" name={c.name || c.email} about={c.name ? `${c.email} · ${c.byYou ? t('page.portal.copiedByYou') : t('page.portal.copiedByTheTeam')}` : c.byYou ? t('page.portal.copiedByYou') : t('page.portal.copiedByTheTeam')} small />
            </li>
          ))}
        </ul>
      ) : (
        <p className="note">{t('page.portal.nobodyCopied')}</p>
      )}
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
  // A sign-in link opened where the portal already is changes only the address's hash: take it then too.
  useEffect(() => {
    const taken = () => {
      const next = linkToken();
      if (next) setToken(next);
    };
    window.addEventListener('hashchange', taken);
    return () => window.removeEventListener('hashchange', taken);
  }, []);
  const [redeemError, setRedeemError] = useState<unknown>(null);
  // An email to someone copied on a request links to it here (D57): opened once they're signed in.
  const [open, setOpen] = useState<string | null>(() => new URLSearchParams(window.location.search).get('request'));
  const me = useQuery({ queryKey: ['portal', 'me'], queryFn: () => get<PortalMe | null>('/portal/me'), retry: false, enabled: !token });
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

  if (redeemError) {
    return (
      <Lone>
        <h1>{t('page.portal.thisSignInLinkHas')}</h1>
        <p className="note">{t('page.portal.linksWorkOnceFor20')}</p>
        <a href="/portal">{t('page.portal.signInAgain')}</a>
      </Lone>
    );
  }
  if (me.isLoading || (token && me.data === undefined && !me.error)) return <Loone />;
  if (!me.data) {
    if (me.error && !(me.error instanceof ApiError && me.error.status === 401)) return <Lone><ErrorNote error={me.error} /></Lone>;
    return <SignIn />;
  }
  const m = me.data;
  const signOut = async () => {
    await post('/portal/sign-out');
    qc.removeQueries({ queryKey: ['portal'] });
    window.location.assign('/portal');
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
          v: m.groups.length
            ? t('page.portal.youAlsoSeeGroups', { groups: new Intl.ListFormat(intlLocale(), { type: 'conjunction' }).format(m.groups.map((g) => t('page.portal.groupAtDesk', { group: g.name, desk: g.desk.name }))) })
            : '.',
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

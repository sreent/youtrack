import type { Confirmed, Passkey, PasskeyOptions, PortalMe, PortalPasskeyAlert, PortalPasskeys } from '@a4a/shared';
import { browserSupportsWebAuthn, browserSupportsWebAuthnAutofill, startAuthentication, startRegistration, WebAuthnAbortService } from '@simplewebauthn/browser';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { ApiError, del, get, patch, post, qs } from '../../api/client';
import { Lone } from '../../app/Auth';
import { agoSaid, Badge } from '../../components/Badges';
import { ErrorNote, Loading } from '../../components/States';
import { errorText, Said } from '../common/bits';
import { Confirm } from '../common/Confirm';
import { passkeyCancelled } from '../identity/Passkeys';
import { t, unsavedPortalChoice } from '../../i18n';
import { RequesterLone } from './PortalLanguage';

/**
 * Requesters' passkeys on the portal (D69): signing in with one, the account page's list, and the
 * mail's "this wasn't me". The portal's own routes alone: a member's passkeys are the profile's.
 */
export const portalPasskeyKeys = { mine: ['portal', 'passkeys'] as const };

type RequestOptionsJSON = Parameters<typeof startAuthentication>[0]['optionsJSON'];
type CreationOptionsJSON = Parameters<typeof startRegistration>[0]['optionsJSON'];

async function portalPasskeyAt<T>(path: string, to: string, where: { desk?: string } = {}, also: Record<string, unknown> = {}): Promise<T> {
  const first = await post<PasskeyOptions & { legacyRpIds?: string[] }>(path, where);
  const ids = [first.rpId, ...(first.legacyRpIds ?? [])].filter((id): id is string => Boolean(id));
  let last: unknown;
  for (const rpId of ids) {
    try {
      const options = rpId === first.rpId ? first : await post<PasskeyOptions>(path, { ...where, rpId });
      const response = await startAuthentication({ optionsJSON: options as unknown as RequestOptionsJSON });
      return await post<T>(to, { response, ...where, ...also });
    } catch (e) {
      last = e;
      if (!passkeyCancelled(e)) throw e;
    }
  }
  throw last;
}

/**
 * Signing in with a passkey from the portal's sign-in page: the browser's autofill on the email field,
 * where it offers passkeys (conditional mediation), asked again every four minutes so its challenge
 * never runs out under it; and a button. As the team's sign-in page does (D62), on the portal's routes.
 */
export function usePortalPasskeySignIn(wanted: boolean, desk: string | undefined, done: (me: PortalMe) => void) {
  const on = wanted && browserSupportsWebAuthn();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [cancelled, setCancelled] = useState(false);
  const finished = useRef(done);
  finished.current = done;
  const where = desk ? { desk } : {};
  const ask = async (autofill: boolean) => {
    // A language chosen on the page signed out comes with the sign-in: theirs, if they have none (D63's revisit).
    const chosen = { locale: unsavedPortalChoice() };
    if (!autofill) return finished.current(await portalPasskeyAt<PortalMe>('/portal/passkey/options', '/portal/passkey', where, chosen));
    const options = await post<PasskeyOptions>('/portal/passkey/options', where);
    const response = await startAuthentication({ optionsJSON: options as unknown as RequestOptionsJSON, useBrowserAutofill: true });
    finished.current(await post<PortalMe>('/portal/passkey', { response, ...where, ...chosen }));
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
  }, [on, armed, desk]);
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

/** The sign-in page's button, and what came of the last try. */
export function PortalPasskeyButton({ passkeys, primary }: { passkeys: ReturnType<typeof usePortalPasskeySignIn>; primary?: boolean }) {
  if (!passkeys.on) return null;
  return (
    <>
      {passkeys.error ? <ErrorNote error={passkeys.error} /> : null}
      {passkeys.cancelled ? (
        <p className="note" role="status">
          {t('page.portal.passkeyCancelled')}
        </p>
      ) : null}
      <button type="button" className={primary ? 'primary' : undefined} disabled={passkeys.busy} onClick={passkeys.start}>
        {passkeys.busy ? t('page.portal.waitingForYourPasskey') : t('page.portal.signInWithAPasskey')}
      </button>
    </>
  );
}

/**
 * Proving the mailbox again, to add or remove one: one of their passkeys, or a new sign-in by a link
 * emailed to them, whose session may for ten minutes. Never the password: a passkey opens every desk
 * that takes passkeys, and a password not every desk takes.
 */
function ConfirmItsYou({ ways, email, onDone, onCancel }: { ways: PortalPasskeys['confirmWith']; email: string; onDone: () => void; onCancel: () => void }) {
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const run = async (fn: () => Promise<unknown>, after: () => void) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      after();
    } catch (e) {
      if (!passkeyCancelled(e)) setError(e);
    } finally {
      setBusy(false);
    }
  };
  const withPasskey = async () => portalPasskeyAt<Confirmed>('/portal/me/confirm/passkey/options', '/portal/me/confirm/passkey');
  return (
    <div className="stack tight" role="group" aria-labelledby="portal-confirm">
      <h3 id="portal-confirm">{t('helpdesk.portalPasskeys.confirmTitle')}</h3>
      <p className="note">{t('helpdesk.portalPasskeys.confirmWhy')}</p>
      {error ? <ErrorNote error={error} /> : null}
      {sent ? <p role="status">{t('helpdesk.portalPasskeys.linkSent', { email })}</p> : null}
      <div className="cluster">
        {ways.passkey ? (
          <button type="button" className="primary" disabled={busy} onClick={() => void run(withPasskey, onDone)}>
            {busy ? t('helpdesk.portalPasskeys.confirming') : t('helpdesk.portalPasskeys.usePasskey')}
          </button>
        ) : null}
        {ways.link ? (
          <button type="button" className={ways.passkey ? undefined : 'primary'} disabled={busy || sent} onClick={() => void run(() => post('/portal/sign-in', { email }), () => setSent(true))}>
            {t('helpdesk.portalPasskeys.emailLink')}
          </button>
        ) : null}
        <button type="button" onClick={onCancel}>
          {t('helpdesk.portalPasskeys.cancel')}
        </button>
      </div>
    </div>
  );
}

/** One passkey, a row of a list that wraps on a phone: its name, when it was added and last used, and what can be done. */
function Item({ p, busy, onRename, onRemove }: { p: Passkey; busy: boolean; onRename: (name: string) => Promise<unknown>; onRemove: () => void }) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(p.name);
  if (editing) {
    return (
      <li className="list-row">
        <form
          className="cluster"
          onSubmit={(e) => {
            e.preventDefault();
            // A refusal is said under the list; the field stays open to try again.
            onRename(name.trim()).then(() => setEditing(false), () => {});
          }}
        >
          <input value={name} onChange={(e) => setName(e.target.value)} aria-label={t('helpdesk.portalPasskeys.newName', { name: p.name })} maxLength={60} required autoFocus />
          <button type="submit" className="small primary" disabled={busy || !name.trim()}>
            {t('helpdesk.portalPasskeys.save')}
          </button>
          <button type="button" className="small" onClick={() => (setEditing(false), setName(p.name))}>
            {t('helpdesk.portalPasskeys.cancel')}
          </button>
        </form>
      </li>
    );
  }
  return (
    <li className="list-row">
      <span>
        <span className="item-name">{p.name}</span>{' '}
        {p.copied ? <Badge tone="bad">{t('helpdesk.portalPasskeys.stopped')}</Badge> : p.synced ? <Badge tone="good">{t('helpdesk.portalPasskeys.synced')}</Badge> : null}{' '}
        <span className="note">
          {t('helpdesk.portalPasskeys.when', { added: agoSaid(p.createdAt), used: p.lastUsedAt ? 'yes' : 'no', last: p.lastUsedAt ? agoSaid(p.lastUsedAt) : '' })}
        </span>
        {/* A line of its own, not joined to the one before by a space, which Japanese and Chinese don't put between sentences. */}
        {p.copied || p.elsewhere ? (
          <span className="item-about">
            {p.copied ? t('helpdesk.portalPasskeys.mayBeCopied') : t('helpdesk.portalPasskeys.elsewhere', { host: p.elsewhere })}
          </span>
        ) : null}
      </span>
      <span className="cluster">
        <button type="button" className="small" disabled={busy} onClick={() => setEditing(true)} aria-label={t('helpdesk.portalPasskeys.renameIt', { name: p.name })}>
          {t('helpdesk.portalPasskeys.rename')}
        </button>
        <Confirm
          small
          label={t('helpdesk.portalPasskeys.remove')}
          name={t('helpdesk.portalPasskeys.removeName', { name: p.name })}
          title={t('helpdesk.portalPasskeys.removeTitle', { name: p.name })}
          about={t('helpdesk.portalPasskeys.removeAbout')}
          confirm={t('helpdesk.portalPasskeys.removeIt')}
          disabled={busy}
          onConfirm={onRemove}
        />
      </span>
    </li>
  );
}

/**
 * The account page's passkeys, where they're of use: where a desk here takes them, or the requester
 * has some to see and remove. Each, when it was added and last used; renaming, removing, adding one.
 */
export function PortalPasskeysSection({ me }: { me: PortalMe }) {
  const qc = useQueryClient();
  const mine = useQuery({ queryKey: portalPasskeyKeys.mine, queryFn: () => get<PortalPasskeys>('/portal/me/passkeys') });
  const [said, setSaid] = useState<{ text: string; bad?: boolean } | null>(null);
  // What waits for "Confirm it's you": adding one, or removing one.
  const [pending, setPending] = useState<{ what: 'add' } | { what: 'remove'; p: Passkey } | null>(null);
  const refresh = () => void qc.invalidateQueries({ queryKey: portalPasskeyKeys.mine });
  const supported = browserSupportsWebAuthn();
  const fail = (e: unknown) => setSaid({ text: passkeyCancelled(e) ? t('helpdesk.portalPasskeys.cancelled') : errorText(e), bad: true });
  // The server's clock decides how recent a sign-in is: when it says to confirm first, the page asks.
  const failOr = (what: NonNullable<typeof pending>) => (e: unknown) => {
    if (e instanceof ApiError && e.code === 'confirm_needed') {
      setSaid(null);
      setPending(what);
      refresh();
    } else fail(e);
  };
  const add = useMutation({
    mutationFn: async () => {
      const options = await post<PasskeyOptions>('/portal/me/passkeys/options');
      const response = await startRegistration({ optionsJSON: options as unknown as CreationOptionsJSON });
      return post<Passkey>('/portal/me/passkeys', { response });
    },
    onSuccess: (p) => {
      setSaid({ text: t('helpdesk.portalPasskeys.isAdded', { name: p.name }) });
      refresh();
    },
    onError: failOr({ what: 'add' }),
  });
  const rename = useMutation({
    mutationFn: ({ id, name }: { id: string; name: string }) => patch<Passkey>(`/portal/me/passkeys/${encodeURIComponent(id)}`, { name }),
    onSuccess: (p) => {
      setSaid({ text: t('helpdesk.portalPasskeys.renamed', { name: p.name }) });
      refresh();
    },
    onError: fail,
  });
  const remove = useMutation({
    mutationFn: async (p: Passkey) => (await del(`/portal/me/passkeys/${encodeURIComponent(p.id)}`), p),
    onSuccess: (p) => {
      setSaid({ text: t('helpdesk.portalPasskeys.removed', { name: p.name }) });
      refresh();
    },
    onError: (e, p) => failOr({ what: 'remove', p })(e),
  });

  if (mine.isLoading) return <Loading what="loadingLine.passkeys" />;
  if (mine.error || !mine.data) return <ErrorNote error={mine.error} />;
  const m = mine.data;
  if (!m.on && !m.passkeys.length) return null;
  const recent = m.confirmedUntil !== null && new Date(m.confirmedUntil).getTime() > Date.now();
  const go = (what: NonNullable<typeof pending>) => {
    setSaid(null);
    if (!recent) return setPending(what);
    if (what.what === 'add') add.mutate();
    else remove.mutate(what.p);
  };
  const busy = add.isPending || rename.isPending || remove.isPending;
  const off = m.off === 'address' ? 'helpdesk.portalPasskeys.offAddress' : m.off === 'instance' ? 'helpdesk.portalPasskeys.offInstance' : m.off === 'desks' ? 'helpdesk.portalPasskeys.offDesks' : null;
  return (
    <section className="stack tight" aria-labelledby="portal-passkeys">
      <h2 id="portal-passkeys">{t('helpdesk.portalPasskeys.title')}</h2>
      <p className="note">{off ? t(off) : t('helpdesk.portalPasskeys.about')}</p>
      {m.on && !supported ? <p className="note">{t('helpdesk.portalPasskeys.notAvailable')}</p> : null}
      {m.passkeys.length ? (
        <ul className="list" aria-label={t('helpdesk.portalPasskeys.listLabel')}>
          {m.passkeys.map((p) => (
            <Item key={p.id} p={p} busy={busy} onRename={(name) => rename.mutateAsync({ id: p.id, name })} onRemove={() => go({ what: 'remove', p })} />
          ))}
        </ul>
      ) : m.on ? (
        <p className="note">{t('helpdesk.portalPasskeys.none')}</p>
      ) : null}
      {pending ? (
        <ConfirmItsYou
          ways={m.confirmWith}
          email={me.email}
          onCancel={() => setPending(null)}
          onDone={() => {
            const what = pending;
            setPending(null);
            refresh();
            if (what.what === 'add') add.mutate();
            else remove.mutate(what.p);
          }}
        />
      ) : m.on ? (
        <div className="cluster">
          <button type="button" disabled={!supported || busy} onClick={() => go({ what: 'add' })}>
            {add.isPending ? t('helpdesk.portalPasskeys.adding') : t('helpdesk.portalPasskeys.add')}
          </button>
        </div>
      ) : null}
      <Said text={said?.text} tone={said?.bad ? 'bad' : undefined} />
    </section>
  );
}

const HEADS: Record<PortalPasskeyAlert['change'], string> = {
  added: 'helpdesk.portalPasskeys.notMeAdded',
  removed: 'helpdesk.portalPasskeys.notMeRemoved',
  copied: 'helpdesk.portalPasskeys.notMeCopied',
};

/**
 * Where a mail's "This wasn't me" leads (`/portal#hdk_…`). Opening it changes nothing (mail scanners
 * open links); the button signs the requester out of the portal everywhere and stops the passkey. It
 * needs no sign-in: it only takes access away.
 */
export function PortalNotMe({ token }: { token: string }) {
  const described = useQuery({ queryKey: ['portal', 'not-me', token], queryFn: () => get<PortalPasskeyAlert>(`/portal/not-me${qs({ token })}`), retry: false });
  const [done, setDone] = useState<PortalPasskeyAlert | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  if (described.error) {
    const missing = described.error instanceof ApiError && described.error.status === 404;
    return (
      <RequesterLone>
        <h1>{missing ? t('helpdesk.portalPasskeys.notMeGone') : t('helpdesk.portalPasskeys.notMeDidntLoad')}</h1>
        {missing ? <p className="note">{t('helpdesk.portalPasskeys.notMeGoneAbout')}</p> : <ErrorNote error={described.error} />}
      </RequesterLone>
    );
  }
  if (!described.data) {
    return (
      <Lone>
        <Loading />
      </Lone>
    );
  }
  const d = done ?? described.data;
  const follow = async () => {
    setBusy(true);
    setError(null);
    try {
      setDone(await post<PortalPasskeyAlert>(`/portal/not-me${qs({ token })}`));
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };
  return (
    <RequesterLone busy={busy}>
      <h1>{d.done ? t('helpdesk.portalPasskeys.notMeDone') : t(HEADS[d.change])}</h1>
      <p>{t('helpdesk.portalPasskeys.notMeWhat', { name: d.name, email: d.email, date: agoSaid(d.changedAt) })}</p>
      {error ? <ErrorNote error={error} /> : null}
      {d.done ? (
        <>
          <p role="status">{t('helpdesk.portalPasskeys.notMeDoneAbout', { change: d.change, name: d.name })}</p>
          <p className="note">{t('helpdesk.portalPasskeys.notMeNext')}</p>
          <div className="cluster">
            <a className="button primary" href="/portal">
              {t('helpdesk.portalPasskeys.notMeSignIn')}
            </a>
          </div>
        </>
      ) : (
        <>
          <p className="note">{t('helpdesk.portalPasskeys.notMeIfNotYou', { change: d.change })}</p>
          <div className="cluster">
            <button type="button" className="danger" onClick={() => void follow()} disabled={busy}>
              {busy ? t('helpdesk.portalPasskeys.notMeSigningOut') : t('helpdesk.portalPasskeys.notMeSignOut')}
            </button>
          </div>
        </>
      )}
    </RequesterLone>
  );
}

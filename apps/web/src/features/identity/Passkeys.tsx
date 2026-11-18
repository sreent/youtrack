import type { Confirmed, MyPasskeys, Passkey, PasskeyOptions } from '@a4a/shared';
import { browserSupportsWebAuthn, startAuthentication, startRegistration, WebAuthnError } from '@simplewebauthn/browser';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { ApiError, del, get, patch, post } from '../../api/client';
import { agoSaid, Badge } from '../../components/Badges';
import { ErrorNote, Loading } from '../../components/States';
import { errorText, FormField, Said, Scroll } from '../common/bits';
import { Confirm } from '../common/Confirm';
import { CodeField } from './TwoFactor';
import { t } from '../../i18n';

export const passkeyKeys = { mine: ['me', 'passkeys'] as const };

type Options = Parameters<typeof startAuthentication>[0]['optionsJSON'];
type CreationOptions = Parameters<typeof startRegistration>[0]['optionsJSON'];

/**
 * A ceremony the person cancelled, or let run out, or one this page started over: the browser says
 * so with NotAllowedError (or AbortError), and it isn't a problem to show as one.
 */
export function passkeyCancelled(e: unknown): boolean {
  const name = e instanceof WebAuthnError ? (e.cause as Error | undefined)?.name : e instanceof Error ? e.name : '';
  return name === 'NotAllowedError' || name === 'AbortError' || (e instanceof WebAuthnError && e.code === 'ERROR_CEREMONY_ABORTED');
}

/** Ask the browser for one of this person's passkeys, with options from `path`, and post its answer to `to`. */
export async function passkeyAt<T>(path: string, to: string): Promise<T> {
  const options = await post<PasskeyOptions>(path);
  const response = await startAuthentication({ optionsJSON: options as unknown as Options });
  return post<T>(to, { response });
}

/** Proving it's you again, for adding or removing a passkey: a password (and a code), or a passkey. */
function ConfirmItsYou({ ways, onDone, onCancel }: { ways: MyPasskeys['confirmWith']; onDone: () => void; onCancel: () => void }) {
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const run = async (fn: () => Promise<Confirmed>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      onDone();
    } catch (e) {
      if (!passkeyCancelled(e)) setError(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <form
      className="form"
      aria-labelledby="confirm-its-you"
      onSubmit={(e) => {
        e.preventDefault();
        void run(() => post<Confirmed>('/me/confirm', { password, ...(ways.code ? { code: code.trim() } : {}) }));
      }}
    >
      <h3 id="confirm-its-you">{t('identity.passkeys.confirmTitle')}</h3>
      <p className="note">{t('identity.passkeys.confirmWhy')}</p>
      {ways.password ? (
        <>
          <FormField label={t('identity.passkeys.password')}>
            {(id) => <input id={id} type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" required autoFocus />}
          </FormField>
          {ways.code ? <CodeField value={code} onChange={setCode} recovery /> : null}
        </>
      ) : null}
      {error ? <ErrorNote error={error} /> : null}
      <div className="cluster">
        {ways.password ? (
          <button type="submit" className="primary" disabled={busy || !password || (ways.code && code.trim().length < 6)}>
            {busy ? t('identity.passkeys.confirming') : t('identity.passkeys.confirm')}
          </button>
        ) : null}
        {ways.passkey ? (
          <button type="button" disabled={busy} onClick={() => void run(() => passkeyAt<Confirmed>('/me/confirm/passkey/options', '/me/confirm/passkey'))}>
            {t('identity.passkeys.usePasskey')}
          </button>
        ) : null}
        <button type="button" onClick={onCancel}>{t('identity.passkeys.cancel')}</button>
      </div>
    </form>
  );
}

function Row({ p, busy, onRename, onRemove }: { p: Passkey; busy: boolean; onRename: (name: string) => Promise<unknown>; onRemove: () => void }) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(p.name);
  return (
    <tr>
      <th scope="row" className="row-head">
        {editing ? (
          <form
            className="cluster"
            onSubmit={(e) => {
              e.preventDefault();
              // A refusal is said under the list, by the mutation; the field stays open to try again.
              onRename(name.trim()).then(() => setEditing(false), () => {});
            }}
          >
            <input value={name} onChange={(e) => setName(e.target.value)} aria-label={t('identity.passkeys.newName', { name: p.name })} maxLength={60} required autoFocus />
            <button type="submit" className="small primary" disabled={busy || !name.trim()}>{t('identity.passkeys.save')}</button>
            <button type="button" className="small" onClick={() => (setEditing(false), setName(p.name))}>{t('identity.passkeys.cancel')}</button>
          </form>
        ) : (
          <span className="item-name">{p.name}</span>
        )}
        {p.copied || p.synced || p.elsewhere ? (
          <span className="item-about">
            {p.copied ? <Badge tone="bad">{t('identity.passkeys.stopped')}</Badge> : p.synced ? <Badge tone="good">{t('identity.passkeys.synced')}</Badge> : null}{' '}
            {p.copied ? t('identity.passkeys.mayBeCopied') : p.elsewhere ? t('identity.passkeys.elsewhere', { host: p.elsewhere }) : null}
          </span>
        ) : null}
      </th>
      <td>{agoSaid(p.createdAt)}</td>
      <td>{p.lastUsedAt ? agoSaid(p.lastUsedAt) : t('identity.passkeys.notUsedYet')}</td>
      <td className="fit">
        <span className="cluster">
          {editing ? null : (
            <button type="button" className="small" disabled={busy} onClick={() => setEditing(true)} aria-label={t('identity.passkeys.renameIt', { name: p.name })}>
              {t('identity.passkeys.rename')}
            </button>
          )}
          <Confirm
            small
            label={t('identity.passkeys.remove')}
            name={t('identity.passkeys.removeName', { name: p.name })}
            title={t('identity.passkeys.removeTitle', { name: p.name })}
            about={t('identity.passkeys.removeAbout')}
            confirm={t('identity.passkeys.removeIt')}
            disabled={busy}
            onConfirm={onRemove}
          />
        </span>
      </td>
    </tr>
  );
}

/** The profile's passkeys: each, when it was added and last used; renaming, removing, adding one. */
export function PasskeysCard() {
  const qc = useQueryClient();
  const mine = useQuery({ queryKey: passkeyKeys.mine, queryFn: () => get<MyPasskeys>('/me/passkeys') });
  const [said, setSaid] = useState<{ text: string; bad?: boolean } | null>(null);
  // What waits for "Confirm it's you": adding one, or removing one.
  const [pending, setPending] = useState<{ what: 'add' } | { what: 'remove'; p: Passkey } | null>(null);
  const refresh = () => void qc.invalidateQueries({ queryKey: passkeyKeys.mine });
  const supported = browserSupportsWebAuthn();
  const fail = (e: unknown) => setSaid({ text: passkeyCancelled(e) ? t('identity.passkeys.cancelled') : errorText(e), bad: true });
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
      const options = await post<PasskeyOptions>('/me/passkeys/options');
      const response = await startRegistration({ optionsJSON: options as unknown as CreationOptions });
      return post<Passkey>('/me/passkeys', { response });
    },
    onSuccess: (p) => {
      setSaid({ text: t('identity.passkeys.isAdded', { name: p.name }) });
      refresh();
    },
    onError: failOr({ what: 'add' }),
  });
  const rename = useMutation({
    mutationFn: ({ id, name }: { id: string; name: string }) => patch<Passkey>(`/me/passkeys/${id}`, { name }),
    onSuccess: (p) => {
      setSaid({ text: t('identity.passkeys.renamed', { name: p.name }) });
      refresh();
    },
    onError: fail,
  });
  const remove = useMutation({
    mutationFn: async (p: Passkey) => (await del(`/me/passkeys/${p.id}`), p),
    onSuccess: (p) => {
      setSaid({ text: t('identity.passkeys.removed', { name: p.name }) });
      refresh();
    },
    onError: (e, p) => failOr({ what: 'remove', p })(e),
  });

  if (mine.isLoading) return <Loading what="loadingLine.passkeys" />;
  if (mine.error || !mine.data) return <ErrorNote error={mine.error} />;
  const m = mine.data;
  const recent = m.confirmedUntil !== null && new Date(m.confirmedUntil).getTime() > Date.now();
  const go = (what: NonNullable<typeof pending>) => {
    setSaid(null);
    if (!recent) return setPending(what);
    if (what.what === 'add') add.mutate();
    else remove.mutate(what.p);
  };
  const busy = add.isPending || rename.isPending || remove.isPending;
  const off = m.off === 'instance' ? 'identity.passkeys.offInstance' : m.off === 'address' ? 'identity.passkeys.offAddress' : m.off === 'passwords' ? 'identity.passkeys.offPasswords' : m.off === 'account' ? 'identity.passkeys.offAccount' : null;
  return (
    <div className="stack">
      {off ? <p className="note">{t(off)}</p> : null}
      {m.on && !supported ? <p className="note">{t('identity.passkeys.notAvailable')}</p> : null}
      {m.passkeys.length ? (
        <Scroll label={t('identity.passkeys.tableOfYourPasskeys')}>
          <table className="figures middle">
            <thead>
              <tr>
                <th scope="col">{t('identity.passkeys.name')}</th>
                <th scope="col">{t('identity.passkeys.added')}</th>
                <th scope="col">{t('identity.passkeys.lastUsed')}</th>
                <th scope="col">
                  <span className="hidden">{t('identity.passkeys.whatYouCanDo')}</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {m.passkeys.map((p) => (
                <Row key={p.id} p={p} busy={busy} onRename={(name) => rename.mutateAsync({ id: p.id, name })} onRemove={() => go({ what: 'remove', p })} />
              ))}
            </tbody>
          </table>
        </Scroll>
      ) : m.on ? (
        <p className="note">{t('identity.passkeys.none')}</p>
      ) : null}
      {pending ? (
        <ConfirmItsYou
          ways={m.confirmWith}
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
          <button type="button" className="primary" disabled={!supported || busy} onClick={() => go({ what: 'add' })}>
            {add.isPending ? t('identity.passkeys.adding') : t('identity.passkeys.add')}
          </button>
        </div>
      ) : null}
      <Said text={said?.text} tone={said?.bad ? 'bad' : undefined} />
    </div>
  );
}

import type { RecoveryCodes, TwoFactorEnrolment, TwoFactorStatus } from '@a4a/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { get, post } from '../../api/client';
import { ErrorNote, Loading } from '../../components/States';
import { errorText, FormField, Said } from '../common/bits';
import { CopyButton } from '../common/CopyButton';

export const twoFactorKeys = { mine: ['me', 'two-factor'] as const };

/** What someone types: six digits from their app, or (when `recovery`) one of their recovery codes. */
export function CodeField({ value, onChange, recovery, autoFocus }: { value: string; onChange: (v: string) => void; recovery?: boolean; autoFocus?: boolean }) {
  return (
    <FormField
      label={recovery ? 'Code' : 'Code from the app'}
      help={recovery ? 'The six digits your authenticator app shows now, or one of your recovery codes.' : 'The six digits it shows now.'}
    >
      {(id, help) => (
        <input
          id={id}
          aria-describedby={help}
          className="mono"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          inputMode={recovery ? 'text' : 'numeric'}
          autoComplete="one-time-code"
          spellCheck={false}
          required
          minLength={6}
          maxLength={20}
          autoFocus={autoFocus}
        />
      )}
    </FormField>
  );
}

/** Recovery codes, shown the once. */
export function RecoveryCodeList({ codes }: { codes: string[] }) {
  return (
    <div className="secret">
      <p>
        <strong>Keep these now.</strong> Your recovery codes: each signs you in once if you lose your phone. Keep them somewhere safe, such as your password
        manager; a4a doesn’t show them again.
      </p>
      <ul aria-label="Recovery codes" className="plain mono">
        {codes.map((c) => (
          <li key={c}>{c}</li>
        ))}
      </ul>
      <div className="cluster">
        <CopyButton text={codes.join('\n')} label="Copy the codes" what="the recovery codes" />
      </div>
    </div>
  );
}

/** Scan the QR code (or type the key), then a code from the app turns it on. */
export function Enrol({ enrolment, confirm, onDone }: { enrolment: TwoFactorEnrolment; confirm: (code: string) => Promise<RecoveryCodes>; onDone: (codes: string[]) => void }) {
  const [code, setCode] = useState('');
  const go = useMutation({ mutationFn: () => confirm(code.trim()), onSuccess: (r) => onDone(r.recoveryCodes) });
  return (
    <form
      className="form"
      onSubmit={(e) => {
        e.preventDefault();
        go.mutate();
      }}
    >
      <p className="note">Scan this with an authenticator app, such as 1Password, Google Authenticator or Microsoft Authenticator.</p>
      <img src={enrolment.qrUrl} width={184} height={184} alt="QR code for your authenticator app" />
      <p className="note">
        Or type this key into it: <span className="mono">{enrolment.secret}</span>
      </p>
      <CodeField value={code} onChange={setCode} />
      {go.error ? <ErrorNote error={go.error} /> : null}
      <div className="cluster">
        <button type="submit" className="primary" disabled={code.trim().length < 6 || go.isPending}>
          {go.isPending ? 'Checking…' : 'Turn it on'}
        </button>
      </div>
    </form>
  );
}

/** The profile's card: whether a code is asked for after the password, and changing that. */
export function TwoFactorCard() {
  const qc = useQueryClient();
  const status = useQuery({ queryKey: twoFactorKeys.mine, queryFn: () => get<TwoFactorStatus>('/me/two-factor') });
  const [enrolment, setEnrolment] = useState<TwoFactorEnrolment | null>(null);
  const [codes, setCodes] = useState<string[] | null>(null);
  const [asking, setAsking] = useState<'renew' | 'off' | null>(null);
  const [code, setCode] = useState('');
  const [said, setSaid] = useState<{ text: string; bad?: boolean } | null>(null);
  const refresh = () => void qc.invalidateQueries({ queryKey: twoFactorKeys.mine });
  const start = useMutation({
    mutationFn: () => post<TwoFactorEnrolment>('/me/two-factor/setup'),
    onSuccess: (e) => {
      setEnrolment(e);
      setCodes(null);
      setSaid(null);
    },
    onError: (e) => setSaid({ text: errorText(e), bad: true }),
  });
  const act = useMutation({
    mutationFn: async (what: 'renew' | 'off') =>
      what === 'renew' ? (await post<RecoveryCodes>('/me/two-factor/recovery-codes', { code: code.trim() })).recoveryCodes : (await post<null>('/me/two-factor/disable', { code: code.trim() }), null),
    onSuccess: (renewed) => {
      setAsking(null);
      setCode('');
      if (renewed) setCodes(renewed);
      setSaid({ text: renewed ? 'New recovery codes: the old ones stopped working.' : 'Two-factor sign-in is off. Your password alone signs you in.' });
      refresh();
    },
    onError: (e) => setSaid({ text: errorText(e), bad: true }),
  });
  if (status.isLoading) return <Loading what="two-factor sign-in" />;
  if (status.error || !status.data) return <ErrorNote error={status.error} />;
  const s = status.data;
  if (enrolment && !s.enabled) {
    return (
      <Enrol
        enrolment={enrolment}
        confirm={(c) => post<RecoveryCodes>('/me/two-factor/confirm', { code: c })}
        onDone={(c) => {
          setEnrolment(null);
          setCodes(c);
          setSaid({ text: 'Two-factor sign-in is on: from now on a4a asks for a code after your password.' });
          refresh();
        }}
      />
    );
  }
  return (
    <div className="stack">
      <p className="note">
        {s.enabled
          ? `On: after your password, a4a asks for a code from your authenticator app. ${s.recoveryCodesLeft} recovery ${s.recoveryCodesLeft === 1 ? 'code' : 'codes'} left.`
          : s.required
            ? 'This instance asks it of everyone who signs in with a password: you’ll set it up at your next sign-in, or now.'
            : 'Off: your password alone signs you in. Turn it on, and a4a asks for a code from an authenticator app too.'}
      </p>
      {codes ? <RecoveryCodeList codes={codes} /> : null}
      {asking ? (
        <form
          className="form"
          onSubmit={(e) => {
            e.preventDefault();
            act.mutate(asking);
          }}
        >
          <CodeField value={code} onChange={setCode} recovery autoFocus />
          <div className="cluster">
            <button type="submit" className={asking === 'off' ? 'danger' : 'primary'} disabled={code.trim().length < 6 || act.isPending}>
              {asking === 'off' ? 'Turn it off' : 'Make new recovery codes'}
            </button>
            <button type="button" onClick={() => (setAsking(null), setCode(''))}>
              Cancel
            </button>
          </div>
        </form>
      ) : (
        <div className="cluster">
          {s.enabled ? (
            <>
              <button type="button" onClick={() => setAsking('renew')}>
                New recovery codes
              </button>
              {s.required ? null : (
                <button type="button" onClick={() => setAsking('off')}>
                  Turn it off
                </button>
              )}
            </>
          ) : (
            <button type="button" className="primary" onClick={() => start.mutate()} disabled={start.isPending}>
              {start.isPending ? 'Starting…' : 'Set up two-factor sign-in'}
            </button>
          )}
        </div>
      )}
      {s.enabled && s.required ? <p className="note">An administrator asks it of everyone here; to move to another phone, ask one to reset yours.</p> : null}
      <Said text={said?.text} tone={said?.bad ? 'bad' : undefined} />
    </div>
  );
}

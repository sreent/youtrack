import type { RecoveryCodes, TwoFactorEnrolment, TwoFactorStatus } from '@a4a/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { get, post } from '../../api/client';
import { ErrorNote, Loading } from '../../components/States';
import { errorText, FormField, Said } from '../common/bits';
import { CopyButton } from '../common/CopyButton';
import { t, tr } from '../../i18n';
import type { ReactNode } from 'react';

export const twoFactorKeys = { mine: ['me', 'two-factor'] as const };

/** What someone types: six digits from their app, or (when `recovery`) one of their recovery codes. */
export function CodeField({ value, onChange, recovery, autoFocus }: { value: string; onChange: (v: string) => void; recovery?: boolean; autoFocus?: boolean }) {
  return (
    <FormField
      label={recovery ? t('identity.twoFactor.code') : t('identity.twoFactor.codeFromTheApp')}
      help={recovery ? t('identity.twoFactor.theSixDigitsYourAuthenticator') : t('identity.twoFactor.theSixDigitsItShows')}
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
      <p>{tr('identity.twoFactor.keepTheseNowYourRecovery', { t0: (c: ReactNode) => <strong>{c}</strong> })}</p>
      <ul aria-label={t('identity.twoFactor.recoveryCodes')} className="plain mono">
        {codes.map((c) => (
          <li key={c}>{c}</li>
        ))}
      </ul>
      <div className="cluster">
        <CopyButton text={codes.join('\n')} label={t('identity.twoFactor.copyTheCodes')} what={t('identity.twoFactor.theRecoveryCodes')} />
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
      <p className="note">{t('identity.twoFactor.scanThisWithAnAuthenticator')}</p>
      <img src={enrolment.qrUrl} width={184} height={184} alt={t('identity.twoFactor.qrCodeForYourAuthenticator')} />
      <p className="note">{tr('identity.twoFactor.orTypeThisKeyInto', { secret: enrolment.secret, t0: (c: ReactNode) => <span className="mono">{c}</span> })}</p>
      <CodeField value={code} onChange={setCode} />
      {go.error ? <ErrorNote error={go.error} /> : null}
      <div className="cluster">
        <button type="submit" className="primary" disabled={code.trim().length < 6 || go.isPending}>
          {go.isPending ? t('identity.twoFactor.checking') : t('identity.twoFactor.turnItOn')}
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
      setSaid({ text: renewed ? t('identity.twoFactor.newRecoveryCodesTheOld') : t('identity.twoFactor.twoFactorSignInIs') });
      refresh();
    },
    onError: (e) => setSaid({ text: errorText(e), bad: true }),
  });
  if (status.isLoading) return <Loading what={t('identity.twoFactor.twoFactorSignIn')} />;
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
          setSaid({ text: t('identity.twoFactor.twoFactorSignInIs2') });
          refresh();
        }}
      />
    );
  }
  return (
    <div className="stack">
      <p className="note">
        {s.enabled
          ? t('identity.twoFactor.onRecoveryCodesLeft', { n: s.recoveryCodesLeft })
          : s.required
            ? t('identity.twoFactor.thisInstanceAsksItOf')
            : t('identity.twoFactor.offYourPasswordAloneSigns')}
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
              {asking === 'off' ? t('identity.twoFactor.turnItOff') : t('identity.twoFactor.makeNewRecoveryCodes')}
            </button>
            <button type="button" onClick={() => (setAsking(null), setCode(''))}>{t('identity.twoFactor.cancel')}</button>
          </div>
        </form>
      ) : (
        <div className="cluster">
          {s.enabled ? (
            <>
              <button type="button" onClick={() => setAsking('renew')}>{t('identity.twoFactor.newRecoveryCodes')}</button>
              {s.required ? null : (
                <button type="button" onClick={() => setAsking('off')}>{t('identity.twoFactor.turnItOff')}</button>
              )}
            </>
          ) : (
            <button type="button" className="primary" onClick={() => start.mutate()} disabled={start.isPending}>
              {start.isPending ? t('identity.twoFactor.starting') : t('identity.twoFactor.setUpTwoFactorSign')}
            </button>
          )}
        </div>
      )}
      {s.enabled && s.required ? <p className="note">{t('identity.twoFactor.anAdministratorAsksItOf')}</p> : null}
      <Said text={said?.text} tone={said?.bad ? 'bad' : undefined} />
    </div>
  );
}

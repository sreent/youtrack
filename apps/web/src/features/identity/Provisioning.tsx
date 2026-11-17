import type { ScimToken, ScimTokenCreated } from '@a4a/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { del, get, post } from '../../api/client';
import { agoSaid } from '../../components/Badges';
import { ErrorNote, Loading } from '../../components/States';
import { errorText, FormField, Said } from '../common/bits';
import { CopyButton } from '../common/CopyButton';
import { t as tx, tr } from '../../i18n';
import type { ReactNode } from 'react';

const scimKeys = { tokens: ['scim', 'tokens'] as const };

/** SCIM tokens: what an identity provider provisions people and groups with (D38). */
export function ProvisioningSection() {
  const qc = useQueryClient();
  const tokens = useQuery({ queryKey: scimKeys.tokens, queryFn: () => get<ScimToken[]>('/scim/tokens') });
  const [name, setName] = useState('');
  const [made, setMade] = useState<ScimTokenCreated | null>(null);
  const [said, setSaid] = useState<{ text: string; bad?: boolean } | null>(null);
  const make = useMutation({
    mutationFn: () => post<ScimTokenCreated>('/scim/tokens', { name: name.trim() }),
    onSuccess: (t) => {
      setMade(t);
      setName('');
      setSaid(null);
      void qc.invalidateQueries({ queryKey: scimKeys.tokens });
    },
    onError: (e) => setSaid({ text: errorText(e), bad: true }),
  });
  const revoke = useMutation({
    mutationFn: (t: ScimToken) => del(`/scim/tokens/${t.id}`),
    onSuccess: (_, t) => {
      setSaid({ text: tx('identity.provisioning.sTokenIsRevokedIt', { name: t.name }) });
      if (made?.id === t.id) setMade(null);
      void qc.invalidateQueries({ queryKey: scimKeys.tokens });
    },
    onError: (e) => setSaid({ text: errorText(e), bad: true }),
  });
  return (
    <section className="card" aria-labelledby="provisioning">
      <div className="section-head">
        <h2 id="provisioning">{tx('identity.provisioning.provisioning')}</h2>
        <span className="note">{tx('identity.provisioning.scim20ForAn')}</span>
      </div>
      <p className="note section-note">{tx('identity.provisioning.anIdentityProviderSuchAs')}</p>
      <div className="stack">
      {tokens.isLoading ? <Loading what="loadingLine.scimTokens" /> : null}
      {tokens.error ? <ErrorNote error={tokens.error} /> : null}
      {tokens.data?.length ? (
        <ul className="plain" aria-label={tx('identity.provisioning.scimTokens')}>
          {tokens.data.map((t) => (
            <li key={t.id} className="cluster">
              <span>
                <strong>{t.name}</strong> <span className="mono">{t.prefix}…</span>{' '}
                <span className="note">{t.lastUsedAt ? tx('identity.provisioning.used', { when: agoSaid(t.lastUsedAt) }) : tx('identity.provisioning.notUsedYet')}</span>
              </span>
              <button type="button" className="small" onClick={() => revoke.mutate(t)} disabled={revoke.isPending} aria-label={tx('identity.provisioning.revokeSToken', { name: t.name })}>{tx('identity.provisioning.revoke')}</button>
            </li>
          ))}
        </ul>
      ) : tokens.data ? (
        <p className="note">{tx('identity.provisioning.noIdentityProviderProvisionsPeople')}</p>
      ) : null}
      {made ? (
        <div className="secret">
          <p>{tr('identity.provisioning.copyItNowGiveThese', { t0: (c: ReactNode) => <strong>{c}</strong>, name: made.name })}</p>
          <FormField label={tx('identity.provisioning.tenantUrl')}>
            {(id) => (
              <output id={id}>
                <code>{made.baseUrl}</code>
              </output>
            )}
          </FormField>
          <FormField label={tx('identity.provisioning.secretToken')}>
            {(id) => (
              <output id={id}>
                <code>{made.token}</code>
              </output>
            )}
          </FormField>
          <div className="cluster">
            <CopyButton text={made.token} label={tx('identity.provisioning.copyTheToken')} what={tx('identity.provisioning.theToken')} />
            <button type="button" className="link" onClick={() => setMade(null)}>{tx('identity.provisioning.iVeGivenIt')}</button>
          </div>
        </div>
      ) : null}
      <form
        className="form-fields"
        onSubmit={(e) => {
          e.preventDefault();
          make.mutate();
        }}
      >
        <FormField label={tx('identity.provisioning.aTokenFor')} help={tx('identity.provisioning.theProviderItSFor')}>
          {(id, help) => <input id={id} aria-describedby={help} value={name} onChange={(e) => setName(e.target.value)} placeholder={tx('identity.provisioning.microsoftEntraId')} maxLength={80} />}
        </FormField>
        <div className="cluster tw:col-span-full">
          <button type="submit" disabled={!name.trim() || make.isPending}>
            {make.isPending ? tx('identity.provisioning.making') : tx('identity.provisioning.makeAScimToken')}
          </button>
        </div>
      </form>
      <Said text={said?.text} tone={said?.bad ? 'bad' : undefined} />
      </div>
    </section>
  );
}

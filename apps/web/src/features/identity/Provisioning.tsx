import type { ScimToken, ScimTokenCreated } from '@a4a/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { del, get, post } from '../../api/client';
import { ago } from '../../components/Badges';
import { ErrorNote, Loading } from '../../components/States';
import { errorText, FormField, Said } from '../common/bits';

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
      setSaid({ text: `${t.name}’s token is revoked: it provisions nothing from now on.` });
      if (made?.id === t.id) setMade(null);
      void qc.invalidateQueries({ queryKey: scimKeys.tokens });
    },
    onError: (e) => setSaid({ text: errorText(e), bad: true }),
  });
  return (
    <section className="card" aria-labelledby="provisioning">
      <div className="section-head">
        <h2 id="provisioning">Provisioning</h2>
        <span className="note">SCIM 2.0, for an identity provider</span>
      </div>
      <p className="note section-note">
        An identity provider such as Microsoft Entra ID can add people and groups here, change them, and ban those it deactivates. Give it the tenant URL and a
        token: it acts as you while you’re an administrator. Groups it provisions follow it, as those the sign-in’s groups fill.
      </p>
      {tokens.isLoading ? <Loading what="SCIM tokens" /> : null}
      {tokens.error ? <ErrorNote error={tokens.error} /> : null}
      {tokens.data?.length ? (
        <ul className="stack" aria-label="SCIM tokens">
          {tokens.data.map((t) => (
            <li key={t.id} className="cluster">
              <span>
                <strong>{t.name}</strong> <span className="mono">{t.prefix}…</span>{' '}
                <span className="note">{t.lastUsedAt ? `used ${ago(t.lastUsedAt)}` : 'not used yet'}</span>
              </span>
              <button type="button" className="small" onClick={() => revoke.mutate(t)} disabled={revoke.isPending} aria-label={`Revoke ${t.name}’s token`}>
                Revoke
              </button>
            </li>
          ))}
        </ul>
      ) : tokens.data ? (
        <p className="note">No identity provider provisions people here yet.</p>
      ) : null}
      {made ? (
        <div className="stack">
          <p className="note">Give {made.name} these now: the token isn’t shown again.</p>
          <FormField label="Tenant URL">{(id) => <output id={id} className="mono">{made.baseUrl}</output>}</FormField>
          <FormField label="Secret token">{(id) => <output id={id} className="mono tw:break-all">{made.token}</output>}</FormField>
        </div>
      ) : null}
      <form
        className="form-fields"
        onSubmit={(e) => {
          e.preventDefault();
          make.mutate();
        }}
      >
        <FormField label="A token for" help="The provider it’s for, so you know which to revoke.">
          {(id, help) => <input id={id} aria-describedby={help} value={name} onChange={(e) => setName(e.target.value)} placeholder="Microsoft Entra ID" maxLength={80} />}
        </FormField>
        <div className="cluster tw:col-span-full">
          <button type="submit" disabled={!name.trim() || make.isPending}>
            {make.isPending ? 'Making…' : 'Make a SCIM token'}
          </button>
        </div>
      </form>
      <Said text={said?.text} tone={said?.bad ? 'bad' : undefined} />
    </section>
  );
}

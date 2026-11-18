import type { PortalProvider, Project } from '@a4a/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { del, get, patch, post } from '../../api/client';
import { keys, useMe } from '../../api/queries';
import { errorText, FormField, Said } from '../common/bits';
import { Confirm } from '../common/Confirm';
import { CopyButton } from '../common/CopyButton';
import { formatList, t } from '../../i18n';

const providersKey = ['portal-providers'];
const list = (s: string) => s.split(/[\s,]+/).map((x) => x.trim().toLowerCase()).filter(Boolean);

/** What a provider is, in a line: where it is, whom it vouches for, and which desks offer it. */
function aboutProvider(p: PortalProvider): string {
  return t('helpdesk.portalSignIn.providerAbout', { issuer: p.issuer, domains: p.domains.length ? 'some' : 'any', list: formatList(p.domains), desks: p.desks.length });
}

/** An administrator adds a provider for requesters: the server's, apart from the team's sign-in (D63). */
function AddProvider({ onAdded }: { onAdded: (p: PortalProvider) => void }) {
  const [form, setForm] = useState({ name: '', issuer: '', clientId: '', clientSecret: '', domains: '' });
  const [said, setSaid] = useState<string | null>(null);
  const add = useMutation({
    mutationFn: () =>
      post<PortalProvider>('/portal-providers', {
        name: form.name,
        issuer: form.issuer.trim(),
        clientId: form.clientId.trim(),
        clientSecret: form.clientSecret || null,
        domains: list(form.domains),
      }),
    onSuccess: (p) => {
      setForm({ name: '', issuer: '', clientId: '', clientSecret: '', domains: '' });
      setSaid(null);
      onAdded(p);
    },
    onError: (e) => setSaid(errorText(e)),
  });
  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) => setForm((f) => ({ ...f, [k]: e.target.value }));
  return (
    <form
      className="form"
      aria-label={t('helpdesk.portalSignIn.addProvider')}
      onSubmit={(e) => {
        e.preventDefault();
        add.mutate();
      }}
    >
      <fieldset className="unframed form" disabled={add.isPending}>
        <FormField label={t('helpdesk.portalSignIn.name')}>{(id) => <input id={id} required maxLength={100} value={form.name} onChange={set('name')} />}</FormField>
        <FormField label={t('helpdesk.portalSignIn.issuer')}>{(id) => <input id={id} type="url" required maxLength={500} placeholder="https://login.acme.com" value={form.issuer} onChange={set('issuer')} />}</FormField>
        <FormField label={t('helpdesk.portalSignIn.clientId')}>{(id) => <input id={id} required maxLength={500} autoComplete="off" value={form.clientId} onChange={set('clientId')} />}</FormField>
        <FormField label={t('helpdesk.portalSignIn.clientSecret')} help={t('helpdesk.portalSignIn.clientSecretHelp')}>
          {(id, help) => <input id={id} type="password" maxLength={2000} autoComplete="off" aria-describedby={help} value={form.clientSecret} onChange={set('clientSecret')} />}
        </FormField>
        <FormField label={t('helpdesk.portalSignIn.domains')} help={t('helpdesk.portalSignIn.domainsHelp')}>
          {(id, help) => <input id={id} placeholder="acme.com" aria-describedby={help} value={form.domains} onChange={set('domains')} />}
        </FormField>
        <div className="cluster end">
          <button type="submit" disabled={!form.name.trim() || !form.issuer.trim() || !form.clientId.trim()}>
            {add.isPending ? t('helpdesk.portalSignIn.adding') : t('helpdesk.portalSignIn.addProvider')}
          </button>
        </div>
      </fieldset>
      {said ? <Said text={said} tone="bad" /> : null}
    </form>
  );
}

/**
 * How a desk's requesters sign in to the portal (D63): today's emailed link, a password, identity
 * providers for requesters, or several; each said for what it means. Administrators keep the
 * providers here too.
 */
export function PortalSignInSettings({ project }: { project: Project }) {
  const qc = useQueryClient();
  const me = useMe();
  const admin = Boolean(me.data?.auth.scopes.includes('admin'));
  const providers = useQuery({ queryKey: providersKey, queryFn: () => get<PortalProvider[]>('/portal-providers'), retry: false });
  const current = project.settings.helpdesk.signIn;
  const savedKey = JSON.stringify(current);
  const [form, setForm] = useState(current);
  const [said, setSaid] = useState<{ text: string; bad?: boolean } | null>(null);
  const [adding, setAdding] = useState(false);
  useEffect(() => setForm(JSON.parse(savedKey) as typeof current), [savedKey]);
  const dirty = JSON.stringify(form) !== savedKey;
  const none = !form.link && !form.password && !form.providers.length;
  const save = useMutation({
    mutationFn: () => patch<Project>(`/projects/${project.key}`, { settings: { helpdesk: { signIn: form } } }),
    onSuccess: (p) => {
      qc.setQueryData(keys.project(p.key), p);
      void qc.invalidateQueries({ queryKey: keys.projects });
      void qc.invalidateQueries({ queryKey: providersKey });
      setSaid({ text: t('helpdesk.portalSignIn.saved') });
    },
    onError: (e) => setSaid({ text: errorText(e), bad: true }),
  });
  const remove = useMutation({
    mutationFn: (p: PortalProvider) => del(`/portal-providers/${encodeURIComponent(p.id)}`).then(() => p),
    onSuccess: (p) => {
      void qc.invalidateQueries({ queryKey: providersKey });
      setSaid({ text: t('helpdesk.portalSignIn.removed', { name: p.name }) });
    },
    onError: (e) => setSaid({ text: errorText(e), bad: true }),
  });
  const all = providers.data ?? [];
  const redirect = all[0]?.redirectUri ?? `${window.location.origin}/api/v1/portal/sso/callback`;
  return (
    <div className="stack">
      <form
        className="form"
        onSubmit={(e) => {
          e.preventDefault();
          if (!none) save.mutate();
        }}
      >
        <fieldset className="unframed form" disabled={save.isPending} aria-label={t('helpdesk.portalSignIn.ways')}>
          <label className="choice">
            <input type="checkbox" checked={form.link} onChange={(e) => setForm((f) => ({ ...f, link: e.target.checked }))} />
            <span>
              {t('helpdesk.portalSignIn.link')}
              <small className="field-help">{t('helpdesk.portalSignIn.linkHelp')}</small>
            </span>
          </label>
          <label className="choice">
            <input type="checkbox" checked={form.password} onChange={(e) => setForm((f) => ({ ...f, password: e.target.checked }))} />
            <span>
              {t('helpdesk.portalSignIn.password')}
              <small className="field-help">{t('helpdesk.portalSignIn.passwordHelp')}</small>
            </span>
          </label>
          {all.map((p) => (
            <label key={p.id} className="choice">
              <input
                type="checkbox"
                checked={form.providers.includes(p.id)}
                onChange={(e) => setForm((f) => ({ ...f, providers: e.target.checked ? [...f.providers, p.id] : f.providers.filter((x) => x !== p.id) }))}
              />
              <span>
                {t('helpdesk.portalSignIn.through', { name: p.name })}
                <small className="field-help">{p.domains.length ? t('helpdesk.portalSignIn.throughSome', { list: formatList(p.domains) }) : t('helpdesk.portalSignIn.throughAny')}</small>
              </span>
            </label>
          ))}
          {!all.length ? <p className="note">{admin ? t('helpdesk.portalSignIn.noProvidersAdmin') : t('helpdesk.portalSignIn.noProviders')}</p> : null}
        </fieldset>
        <div className="cluster">
          <button type="submit" className="primary" disabled={!dirty || none || save.isPending}>
            {save.isPending ? t('helpdesk.portalSignIn.saving') : t('helpdesk.portalSignIn.save')}
          </button>
          <Said text={none ? t('helpdesk.portalSignIn.oneWay') : said?.text} tone={none || said?.bad ? 'bad' : undefined} />
        </div>
      </form>
      {admin ? (
        <section className="stack tight" aria-labelledby="portal-providers">
          <h3 id="portal-providers">{t('helpdesk.portalSignIn.providers')}</h3>
          <p className="note">{t('helpdesk.portalSignIn.providersNote')}</p>
          <div className="cluster">
            <span className="label">{t('helpdesk.portalSignIn.redirectUri')}</span>
            <code>{redirect}</code>
            <CopyButton text={redirect} what={t('helpdesk.portalSignIn.redirectUri')} />
          </div>
          {all.length ? (
            <ul className="list" aria-label={t('helpdesk.portalSignIn.providers')}>
              {all.map((p) => (
                <li key={p.id} className="list-row">
                  <span>
                    {p.name} <span className="note">{aboutProvider(p)}</span>
                  </span>
                  <Confirm
                    label={t('helpdesk.portalSignIn.remove')}
                    name={t('helpdesk.portalSignIn.removeProvider', { name: p.name })}
                    title={t('helpdesk.portalSignIn.removeTitle', { name: p.name })}
                    about={t('helpdesk.portalSignIn.removeAbout')}
                    confirm={t('helpdesk.portalSignIn.removeIt')}
                    onConfirm={() => remove.mutate(p)}
                  />
                </li>
              ))}
            </ul>
          ) : null}
          {adding ? (
            <AddProvider
              onAdded={(p) => {
                void qc.invalidateQueries({ queryKey: providersKey });
                setAdding(false);
                setSaid({ text: t('helpdesk.portalSignIn.added', { name: p.name }) });
              }}
            />
          ) : (
            <div className="cluster">
              <button type="button" onClick={() => setAdding(true)}>
                {t('helpdesk.portalSignIn.addProvider')}
              </button>
            </div>
          )}
        </section>
      ) : null}
    </div>
  );
}

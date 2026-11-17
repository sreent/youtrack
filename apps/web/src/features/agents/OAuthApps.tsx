/**
 * Apps that sign in to a4a's MCP server by themselves, over OAuth (D28): the address to give them,
 * and the apps a person allowed, beside their tokens, each revocable at once.
 */
import type { OAuthGrant } from '@a4a/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { del } from '../../api/client';
import { keys, useOAuthGrants, useSetupStatus } from '../../api/queries';
import { ago } from '../../components/Badges';
import { ErrorNote, Loading } from '../../components/States';
import { errorText, Said, Scroll } from '../common/bits';
import { Confirm } from '../common/Confirm';
import { CopyButton } from '../common/CopyButton';
import { t, tr } from '../../i18n';

/** For clients that sign in by themselves, such as Claude: the address is all they need. */
export function SignInInstead() {
  const setup = useSetupStatus();
  if (!setup.data?.mcpOAuth) return null;
  const address = `${window.location.origin}/mcp`;
  return (
    <div className="stack tight section-note">
      <p className="note">{t('agents.oAuthApps.clientsThatSignInBy')}</p>
      <div className="cluster">
        <code>{address}</code>
        <CopyButton text={address} label={t('agents.oAuthApps.copyTheAddress')} what={t('agents.oAuthApps.theAddressOfA4aS')} />
      </div>
    </div>
  );
}

const appName = (g: OAuthGrant) => g.client.name ?? t('agents.oAuthApps.anApp');

/** The apps a person allowed: what each may do and where, and a way to end it. */
export function AllowedApps() {
  const qc = useQueryClient();
  const setup = useSetupStatus();
  const grants = useOAuthGrants();
  const [said, setSaid] = useState<{ text: string; bad?: boolean } | null>(null);
  const revoke = useMutation({
    mutationFn: (g: OAuthGrant) => del(`/me/oauth-grants/${g.id}`),
    onSuccess: (_, g) => {
      setSaid({ text: t('agents.oAuthApps.isRevokedItCanT', { appName: appName(g) }) });
      void qc.invalidateQueries({ queryKey: keys.oauthGrants });
    },
    onError: (e) => setSaid({ text: errorText(e), bad: true }),
  });
  // With OAuth off, the section shows only while apps allowed before are still listed.
  if (!setup.data?.mcpOAuth && !grants.data?.length) return null;
  return (
    <section className="card" aria-labelledby="your-apps">
      <div className="section-head">
        <h2 id="your-apps">{t('agents.oAuthApps.appsYouAllowed')}</h2>
        <span className="note">{t('agents.oAuthApps.eachSignedInAsYou')}</span>
      </div>
      <Said text={said?.text} tone={said?.bad ? 'bad' : undefined} />
      {grants.isLoading ? <Loading what="loadingLine.yourApps" /> : null}
      {grants.error ? <ErrorNote error={grants.error} /> : null}
      {grants.data && !grants.data.length ? (
        <p className="note">{t('agents.oAuthApps.noAppHasSignedIn')}</p>
      ) : null}
      {grants.data?.length ? (
        <Scroll label={t('agents.oAuthApps.tableOfTheAppsYou')}>
          <table className="figures middle">
            <thead>
              <tr>
                <th scope="col">{t('agents.oAuthApps.app')}</th>
                <th scope="col">{t('agents.oAuthApps.may')}</th>
                <th scope="col">{t('agents.oAuthApps.where')}</th>
                <th scope="col">{t('agents.oAuthApps.lastUsed')}</th>
                <th scope="col">{t('agents.oAuthApps.allowed')}</th>
                <th scope="col">
                  <span className="hidden">{t('agents.oAuthApps.revoke')}</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {grants.data.map((g) => (
                <tr key={g.id}>
                  <td>
                    <strong>{appName(g)}</strong>
                    <span className="item-about">{tr('agents.oAuthApps.backTo', { join: g.client.redirectHosts.join(', ') })}</span>
                  </td>
                  <td>
                    <span className="chips">
                      {g.scopes.map((s) => (
                        <span key={s} className="chip">
                          {s}
                        </span>
                      ))}
                    </span>
                  </td>
                  <td>
                    {g.projects === null ? (
                      t('agents.oAuthApps.everyProject')
                    ) : g.projects.length ? (
                      <span className="chips">
                        {g.projects.map((k) => (
                          <span key={k} className="chip mono">
                            {k}
                          </span>
                        ))}
                      </span>
                    ) : (
                      <span className="muted">{t('agents.oAuthApps.noProjectAnyMore')}</span>
                    )}
                  </td>
                  <td>{g.lastUsedAt ? <time dateTime={g.lastUsedAt}>{ago(g.lastUsedAt)}</time> : <span className="muted">{t('agents.oAuthApps.never')}</span>}</td>
                  <td>
                    <time dateTime={g.createdAt}>{ago(g.createdAt)}</time>
                  </td>
                  <td className="fit">
                    <Confirm
                      small
                      label={t('agents.oAuthApps.revokeIt')}
                      name={t('agents.oAuthApps.revoke3', { appName: appName(g) })}
                      title={t('agents.oAuthApps.revoke2', { appName: appName(g) })}
                      about={t('agents.oAuthApps.itLosesAccessAtOnce')}
                      confirm={t('agents.oAuthApps.revokeIt')}
                      disabled={revoke.isPending}
                      onConfirm={() => revoke.mutate(g)}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Scroll>
      ) : null}
    </section>
  );
}

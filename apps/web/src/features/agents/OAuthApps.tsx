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

/** For clients that sign in by themselves, such as Claude: the address is all they need. */
export function SignInInstead() {
  const setup = useSetupStatus();
  if (!setup.data?.mcpOAuth) return null;
  const address = `${window.location.origin}/mcp`;
  return (
    <div className="stack tight section-note">
      <p className="note">
        Clients that sign in by themselves, such as Claude and Claude Code, need only this address. They bring you to a4a to choose what they may do, and
        show under Apps you allowed. For any other client, create a token.
      </p>
      <div className="cluster">
        <code>{address}</code>
        <CopyButton text={address} label="Copy the address" what="the address of a4a’s MCP server" />
      </div>
    </div>
  );
}

const appName = (g: OAuthGrant) => g.client.name ?? 'An app';

/** The apps a person allowed: what each may do and where, and a way to end it. */
export function AllowedApps() {
  const qc = useQueryClient();
  const setup = useSetupStatus();
  const grants = useOAuthGrants();
  const [said, setSaid] = useState<{ text: string; bad?: boolean } | null>(null);
  const revoke = useMutation({
    mutationFn: (g: OAuthGrant) => del(`/me/oauth-grants/${g.id}`),
    onSuccess: (_, g) => {
      setSaid({ text: `${appName(g)} is revoked: it can’t reach a4a any more. If it asks again, a4a asks you again.` });
      void qc.invalidateQueries({ queryKey: keys.oauthGrants });
    },
    onError: (e) => setSaid({ text: errorText(e), bad: true }),
  });
  // With OAuth off, the section shows only while apps allowed before are still listed.
  if (!setup.data?.mcpOAuth && !grants.data?.length) return null;
  return (
    <section className="card" aria-labelledby="your-apps">
      <div className="section-head">
        <h2 id="your-apps">Apps you allowed</h2>
        <span className="note">Each signed in as you over MCP, never beyond your role.</span>
      </div>
      <Said text={said?.text} tone={said?.bad ? 'bad' : undefined} />
      {grants.isLoading ? <Loading what="your apps" /> : null}
      {grants.error ? <ErrorNote error={grants.error} /> : null}
      {grants.data && !grants.data.length ? (
        <p className="note">No app has signed in as you yet. When one asks, a4a shows you who asks and for what, and you choose.</p>
      ) : null}
      {grants.data?.length ? (
        <Scroll label="Table of the apps you allowed">
          <table className="figures middle">
            <thead>
              <tr>
                <th scope="col">App</th>
                <th scope="col">May</th>
                <th scope="col">Where</th>
                <th scope="col">Last used</th>
                <th scope="col">Allowed</th>
                <th scope="col">
                  <span className="hidden">Revoke</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {grants.data.map((g) => (
                <tr key={g.id}>
                  <td>
                    <strong>{appName(g)}</strong>
                    <span className="item-about">back to {g.client.redirectHosts.join(', ')}</span>
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
                      'Every project'
                    ) : g.projects.length ? (
                      <span className="chips">
                        {g.projects.map((k) => (
                          <span key={k} className="chip mono">
                            {k}
                          </span>
                        ))}
                      </span>
                    ) : (
                      <span className="muted">No project any more</span>
                    )}
                  </td>
                  <td>{g.lastUsedAt ? <time dateTime={g.lastUsedAt}>{ago(g.lastUsedAt)}</time> : <span className="muted">Never</span>}</td>
                  <td>
                    <time dateTime={g.createdAt}>{ago(g.createdAt)}</time>
                  </td>
                  <td className="fit">
                    <Confirm
                      small
                      label="Revoke it"
                      name={`Revoke ${appName(g)}`}
                      title={`Revoke ${appName(g)}?`}
                      about="It loses access at once: every token it holds stops working. If it asks again, a4a asks you again."
                      confirm="Revoke it"
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

import type { VcsDelivery, VcsDeliveryOutcome, VcsIntegration, VcsIntegrationCreated, VcsProvider, VcsTestResult } from '@a4a/shared';
import { VCS_PROVIDERS, VCS_PROVIDER_NAMES } from '@a4a/shared/constants';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router';
import { del, get, patch, post } from '../api/client';
import { useProjects } from '../api/queries';
import { ago, Badge } from '../components/Badges';
import { ErrorNote, Loading, PageHead } from '../components/States';
import { AdminOnly, errorText, FormField, Said, Scroll } from '../features/common/bits';
import { Confirm } from '../features/common/Confirm';
import { CopyButton } from '../features/common/CopyButton';
import { whenRead } from '../features/common/format';

const vcsKeys = {
  all: ['vcs', 'integrations'] as const,
  deliveries: (id: string) => ['vcs', 'integrations', id, 'deliveries'] as const,
};
const useIntegrations = () => useQuery({ queryKey: vcsKeys.all, queryFn: () => get<VcsIntegration[]>('/vcs/integrations') });
const useDeliveries = (id: string, enabled: boolean) =>
  useQuery({ queryKey: vcsKeys.deliveries(id), queryFn: () => get<VcsDelivery[]>(`/vcs/integrations/${id}/deliveries`), enabled, refetchInterval: enabled ? 15_000 : false });

const PROVIDER = VCS_PROVIDER_NAMES;
const isBitbucket = (p: VcsProvider) => p === 'bitbucket' || p === 'bitbucket-dc';

/** How a delivery went, with its shape. */
const OUTCOME: Record<VcsDeliveryOutcome, { tone: 'good' | 'warn' | 'bad' | 'idle'; word: string }> = {
  processed: { tone: 'good', word: 'handled' },
  ignored: { tone: 'idle', word: 'ignored' },
  duplicate: { tone: 'idle', word: 'had it already' },
  received: { tone: 'warn', word: 'being handled' },
  refused: { tone: 'bad', word: 'refused' },
  failed: { tone: 'bad', word: 'failed' },
};

/** Where to put the URL and secret, in the provider's own words. */
function Steps({ provider }: { provider: VcsProvider }) {
  switch (provider) {
    case 'github':
      return (
        <ol>
          <li>
            In the repository on GitHub, open <strong>Settings</strong>, then <strong>Webhooks</strong>, and <strong>Add webhook</strong>.
          </li>
          <li>
            Payload URL: the URL above. Content type: <code>application/json</code>. Secret: the secret above.
          </li>
          <li>
            Under “Which events”, choose <strong>Let me select individual events</strong>, and tick <strong>Pushes</strong> and <strong>Pull requests</strong>.
          </li>
        </ol>
      );
    case 'gitlab':
      return (
        <ol>
          <li>
            In the project on GitLab, open <strong>Settings</strong>, then <strong>Webhooks</strong>, and <strong>Add new webhook</strong>.
          </li>
          <li>URL: the URL above. Secret token: the secret above.</li>
          <li>
            Under Trigger, tick <strong>Push events</strong> and <strong>Merge request events</strong>.
          </li>
        </ol>
      );
    case 'bitbucket':
      return (
        <ol>
          <li>
            In the repository on Bitbucket, open <strong>Repository settings</strong>, then <strong>Webhooks</strong>, and <strong>Add webhook</strong>.
          </li>
          <li>URL: the URL above. Secret: the secret above.</li>
          <li>
            Under Triggers, choose from the full list: <strong>Push</strong>, and the pull request's <strong>Created</strong>, <strong>Updated</strong>,{' '}
            <strong>Merged</strong> and <strong>Declined</strong>.
          </li>
          <li>For pushes of more than five commits, give a4a a repository access token that may read the repository.</li>
        </ol>
      );
    case 'bitbucket-dc':
      return (
        <ol>
          <li>
            In the repository, open <strong>Repository settings</strong>, then <strong>Webhooks</strong>, and <strong>Create webhook</strong>.
          </li>
          <li>URL: the URL above. Secret: the secret above.</li>
          <li>
            Under Events, tick the repository's <strong>Push</strong>, and the pull request's <strong>Opened</strong>, <strong>Modified</strong>,{' '}
            <strong>Merged</strong> and <strong>Declined</strong>.
          </li>
          <li>
            Bitbucket Data Center's pushes don't say what their commits say: give a4a an HTTP access token with <strong>Repository read</strong>, so it reads them.
          </li>
        </ol>
      );
    case 'gitea':
      return (
        <ol>
          <li>
            In the repository, open <strong>Settings</strong>, then <strong>Webhooks</strong>, and add a <strong>Gitea</strong> (or <strong>Forgejo</strong>) webhook.
          </li>
          <li>
            Target URL: the URL above. Method <code>POST</code>, content type <code>application/json</code>. Secret: the secret above.
          </li>
          <li>
            Under “Trigger on”, choose custom events: <strong>Push</strong> and <strong>Pull request</strong>.
          </li>
        </ol>
      );
  }
}

function Deliveries({ integration }: { integration: VcsIntegration }) {
  const deliveries = useDeliveries(integration.id, true);
  if (deliveries.isLoading) return <Loading what="its deliveries" />;
  if (deliveries.error) return <ErrorNote error={deliveries.error} />;
  if (!deliveries.data?.length) return <p className="note">Nothing has come yet. Send a test, or push a commit that mentions an issue.</p>;
  return (
    <Scroll label="Table of recent deliveries">
      <table className="figures">
        <thead>
          <tr>
            <th scope="col">When</th>
            <th scope="col">Event</th>
            <th scope="col">How it went</th>
            <th scope="col">What it did</th>
          </tr>
        </thead>
        <tbody>
          {deliveries.data.map((d) => (
            <tr key={d.id}>
              <td>
                <time dateTime={d.createdAt} title={d.createdAt}>
                  {whenRead(d.createdAt)}
                </time>
              </td>
              <td>
                <span className="mono">{d.event}</span>
                <span className="item-about">{d.test ? 'a test' : d.deliveryId ? <span className="mono">{d.deliveryId.slice(0, 13)}</span> : null}</span>
              </td>
              <td>
                <Badge tone={OUTCOME[d.outcome].tone}>
                  {OUTCOME[d.outcome].word}
                  {d.outcome === 'refused' || d.outcome === 'failed' ? `, ${d.statusCode}` : ''}
                </Badge>
                {d.linked || d.applied ? (
                  <span className="item-about">
                    {d.linked} linked{d.applied ? `, ${d.applied} ${d.applied === 1 ? 'command' : 'commands'} applied` : ''}
                  </span>
                ) : null}
              </td>
              <td>{d.message}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </Scroll>
  );
}

function Secret({ made, onKept }: { made: VcsIntegrationCreated; onKept: () => void }) {
  return (
    <div className="secret" role="status">
      <p>
        <strong>Copy the secret now.</strong> This is the only time a4a shows it. {PROVIDER[made.provider]} sends it with each delivery, and a4a refuses any delivery
        without it.
      </p>
      <code>{made.webhookUrl}</code>
      <code>{made.secret}</code>
      <div className="cluster">
        <CopyButton text={made.webhookUrl} label="Copy the URL" what="the URL" />
        <CopyButton text={made.secret} label="Copy the secret" what="the secret" />
        <button type="button" className="link" onClick={onKept}>
          I've kept it
        </button>
      </div>
      <Steps provider={made.provider} />
    </div>
  );
}

/** What an access token is for, at each Bitbucket. */
const TOKEN_HELP: Partial<Record<VcsProvider, string>> = {
  bitbucket: 'Optional. Bitbucket sends the latest five commits a push gives a branch; with a repository access token that may read it, a4a reads the rest.',
  'bitbucket-dc': 'Its pushes name the commits they moved, not what they say: with an HTTP access token that may read the repository, a4a reads them.',
};

/** A Bitbucket integration's access token: given, replaced or taken away. Never shown again. */
function AccessToken({ integration, onSaid }: { integration: VcsIntegration; onSaid: (said: { text: string; bad?: boolean }) => void }) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [token, setToken] = useState('');
  const save = useMutation({
    mutationFn: (accessToken: string | null) => patch<VcsIntegration>(`/vcs/integrations/${integration.id}`, { accessToken }),
    onSuccess: (i) => {
      void qc.invalidateQueries({ queryKey: vcsKeys.all });
      setOpen(false);
      setToken('');
      onSaid({ text: i.hasAccessToken ? 'Saved: a4a reads the commits a delivery leaves out with it.' : 'The token is gone: a4a reads what deliveries carry.' });
    },
    onError: (e) => onSaid({ text: errorText(e), bad: true }),
  });
  if (!open) {
    return (
      <>
        <button type="button" className="small" onClick={() => setOpen(true)}>
          {integration.hasAccessToken ? 'Replace its access token' : 'Give it an access token'}
        </button>
        {integration.hasAccessToken ? (
          <Confirm
            small
            label="Remove its access token"
            title={`Remove ${integration.name}'s access token?`}
            about={
              integration.provider === 'bitbucket-dc'
                ? 'Without it, a4a can’t read what pushes’ commits say, so it links none.'
                : 'Without it, a4a reads the latest five commits a push gives a branch.'
            }
            confirm="Remove it"
            disabled={save.isPending}
            onConfirm={() => save.mutate(null)}
          />
        ) : null}
      </>
    );
  }
  return (
    <form
      className="cluster"
      onSubmit={(e) => {
        e.preventDefault();
        if (token.trim()) save.mutate(token.trim());
      }}
    >
      <FormField label="Access token" className="inline">
        {(id) => <input id={id} type="password" value={token} onChange={(e) => setToken(e.target.value)} autoComplete="off" required className="mono" />}
      </FormField>
      <button type="submit" className="small primary" disabled={!token.trim() || save.isPending}>
        Save the token
      </button>
      <button type="button" className="small" onClick={() => setOpen(false)}>
        Cancel
      </button>
    </form>
  );
}

function IntegrationCard({ integration, projectNames }: { integration: VcsIntegration; projectNames: Map<string, string> }) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [said, setSaid] = useState<{ text: string; bad?: boolean } | null>(null);
  const [rotated, setRotated] = useState<VcsIntegrationCreated | null>(null);
  const refresh = () => void qc.invalidateQueries({ queryKey: vcsKeys.all });
  const toggle = useMutation({
    mutationFn: (active: boolean) => patch<VcsIntegration>(`/vcs/integrations/${integration.id}`, { active }),
    onSuccess: (i) => {
      refresh();
      setSaid({ text: i.active ? 'It takes deliveries again.' : 'It is paused: deliveries are answered, logged, and not read.' });
    },
    onError: (e) => setSaid({ text: errorText(e), bad: true }),
  });
  const test = useMutation({
    mutationFn: () => post<VcsTestResult>(`/vcs/integrations/${integration.id}/test`),
    onSuccess: (r) => {
      setOpen(true);
      void qc.invalidateQueries({ queryKey: vcsKeys.deliveries(integration.id) });
      setSaid(r.delivered ? { text: r.message } : { text: r.message || 'The test didn’t go through. Its delivery is below.', bad: true });
    },
    onError: (e) => setSaid({ text: errorText(e), bad: true }),
  });
  const rotate = useMutation({
    mutationFn: () => post<VcsIntegrationCreated>(`/vcs/integrations/${integration.id}/secret`),
    onSuccess: (made) => {
      refresh();
      setRotated(made);
      setSaid(null);
    },
    onError: (e) => setSaid({ text: errorText(e), bad: true }),
  });
  const remove = useMutation({
    mutationFn: () => del(`/vcs/integrations/${integration.id}`),
    onSuccess: refresh,
    onError: (e) => setSaid({ text: errorText(e), bad: true }),
  });
  const where = integration.projects.length ? `issues of ${integration.projects.map((k) => projectNames.get(k) ?? k).join(', ')}` : 'issues of every project';
  const bitbucket = isBitbucket(integration.provider);
  return (
    <li className="card hook">
      <div className="hook-head">
        <div className="hook-what">
          <span className="mono hook-url">{integration.name}</span>
          <span className="item-about">
            {PROVIDER[integration.provider]} · looks for {where} · its secret begins <span className="mono">{integration.secretPrefix}</span> · added {ago(integration.createdAt)}
            {integration.lastDeliveryAt ? ` · last delivery ${ago(integration.lastDeliveryAt)}` : ' · nothing has come yet'}
          </span>
        </div>
        {integration.active ? <Badge tone="good">takes deliveries</Badge> : <Badge tone="idle">paused</Badge>}
      </div>
      <div className="cluster">
        <span className="note">Webhook URL</span>
        <code className="hook-url">{integration.webhookUrl}</code>
        <CopyButton text={integration.webhookUrl} label="Copy it" what="the URL" />
      </div>
      {bitbucket ? (
        <div className="cluster">
          {integration.provider === 'bitbucket-dc' && integration.baseUrl ? (
            <span className="note">
              Reads commits at <span className="mono">{integration.baseUrl}</span>
            </span>
          ) : null}
          {integration.hasAccessToken ? (
            <Badge tone="good">reads commits with its token</Badge>
          ) : (
            <Badge tone={integration.provider === 'bitbucket-dc' ? 'warn' : 'idle'}>{integration.provider === 'bitbucket-dc' ? 'no access token: links no commits' : 'no access token'}</Badge>
          )}
          <AccessToken integration={integration} onSaid={setSaid} />
        </div>
      ) : null}
      <div className="cluster">
        <button type="button" onClick={() => test.mutate()} disabled={test.isPending}>
          {test.isPending ? 'Sending…' : 'Send a test'}
        </button>
        <button type="button" onClick={() => toggle.mutate(!integration.active)} disabled={toggle.isPending}>
          {integration.active ? 'Pause it' : 'Turn it back on'}
        </button>
        <button type="button" className="link" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
          {open ? 'Hide its deliveries' : 'Show its deliveries'}
        </button>
        <span className="grow" />
        <Confirm
          small
          label="Give it a new secret"
          title={`Give ${integration.name} a new secret?`}
          about={`The old one stops working at once: until ${PROVIDER[integration.provider]} has the new one, a4a refuses what it sends.`}
          confirm="Make a new one"
          disabled={rotate.isPending}
          onConfirm={() => rotate.mutate()}
        />
        <Confirm
          small
          label="Remove it"
          title={`Remove the integration ${integration.name}?`}
          about="a4a stops taking its deliveries at once, and its delivery log goes with it. The commits and pull requests already linked stay on their issues."
          confirm="Remove it"
          disabled={remove.isPending}
          onConfirm={() => remove.mutate()}
        />
      </div>
      {rotated ? <Secret made={rotated} onKept={() => setRotated(null)} /> : null}
      <Said text={said?.text} tone={said?.bad ? 'bad' : undefined} />
      {open ? (
        <div className="hook-log">
          <h3>Recent deliveries</h3>
          <Deliveries integration={integration} />
        </div>
      ) : null}
    </li>
  );
}

function AddIntegration() {
  const qc = useQueryClient();
  const projects = useProjects();
  const [provider, setProvider] = useState<VcsProvider>('github');
  const [name, setName] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [token, setToken] = useState('');
  const [every, setEvery] = useState(true);
  const [chosen, setChosen] = useState<Set<string>>(() => new Set());
  const [made, setMade] = useState<VcsIntegrationCreated | null>(null);
  const dc = provider === 'bitbucket-dc';
  const add = useMutation({
    mutationFn: () =>
      post<VcsIntegrationCreated>('/vcs/integrations', {
        provider,
        name: name.trim(),
        projects: every ? [] : [...chosen],
        ...(dc ? { baseUrl: baseUrl.trim() } : {}),
        ...(isBitbucket(provider) && token.trim() ? { accessToken: token.trim() } : {}),
      }),
    onSuccess: (i) => {
      setMade(i);
      setName('');
      setBaseUrl('');
      setToken('');
      void qc.invalidateQueries({ queryKey: vcsKeys.all });
    },
  });
  return (
    <section className="card" aria-labelledby="add-vcs">
      <h2 id="add-vcs">Add an integration</h2>
      <form
        className="form"
        onSubmit={(e) => {
          e.preventDefault();
          add.mutate();
        }}
      >
        <fieldset className="choice-group columns">
          <legend>From</legend>
          {VCS_PROVIDERS.map((p) => (
            <label key={p} className="choice">
              <input type="radio" name="provider" value={p} checked={provider === p} onChange={() => setProvider(p)} />
              <span>{PROVIDER[p]}</span>
            </label>
          ))}
        </fieldset>
        <FormField label="Name" help="Usually the repository, so people know where its commits come from.">
          {(id, help) => (
            <input
              id={id}
              aria-describedby={help}
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
              maxLength={120}
              placeholder={dc ? 'PROJ/backend' : 'acme/backend'}
              className="mono"
            />
          )}
        </FormField>
        {dc ? (
          <FormField label="Bitbucket’s address" help="Where people open it, https. a4a reads the commits a push moved there.">
            {(id, help) => (
              <input
                id={id}
                aria-describedby={help}
                type="url"
                value={baseUrl}
                onChange={(e) => setBaseUrl(e.target.value)}
                required
                placeholder="https://bitbucket.acme.example"
                className="mono"
              />
            )}
          </FormField>
        ) : null}
        {isBitbucket(provider) ? (
          <FormField label={dc ? 'An HTTP access token' : 'An access token, if pushes are long'} help={TOKEN_HELP[provider]}>
            {(id, help) => <input id={id} aria-describedby={help} type="password" value={token} onChange={(e) => setToken(e.target.value)} autoComplete="off" className="mono" />}
          </FormField>
        ) : null}
        <fieldset className="choice-group columns">
          <legend>Issues it looks for</legend>
          <label className="choice tw:col-span-full">
            <input type="checkbox" checked={every} onChange={(e) => setEvery(e.target.checked)} />
            <span>Of every project, members-only ones and ones added later too</span>
          </label>
          {!every
            ? (projects.data ?? []).map((p) => (
                <label key={p.key} className="choice">
                  <input
                    type="checkbox"
                    checked={chosen.has(p.key)}
                    onChange={() =>
                      setChosen((s) => {
                        const n = new Set(s);
                        if (n.has(p.key)) n.delete(p.key);
                        else n.add(p.key);
                        return n;
                      })
                    }
                  />
                  <span>
                    {p.name}
                    <small className="field-help mono">{p.key}</small>
                  </span>
                </label>
              ))
            : null}
        </fieldset>
        <div className="cluster">
          <button type="submit" className="primary" disabled={add.isPending || !name.trim() || (dc && !baseUrl.trim()) || (!every && !chosen.size)}>
            {add.isPending ? 'Adding…' : 'Add the integration'}
          </button>
        </div>
        {add.error ? <ErrorNote error={add.error} /> : null}
      </form>
      {made ? <Secret made={made} onKept={() => setMade(null)} /> : null}
    </section>
  );
}

/** Where commits and pull requests come in from version control: each integration, its test, and how each delivery went. */
export default function IntegrationsPage() {
  const integrations = useIntegrations();
  const projects = useProjects();
  const names = new Map((projects.data ?? []).map((p) => [p.key, p.name]));
  return (
    <AdminOnly title="Integrations">
      <PageHead
        title="Integrations"
        about="GitHub, GitLab, Bitbucket, Gitea and Forgejo tell a4a about pushes and pull requests. A commit or pull request that mentions an issue is linked to it, and a commit can change it: BACK-12 #Fixed."
      />
      <section className="card" aria-labelledby="vcs-list">
        <h2 id="vcs-list">Where they come from</h2>
        {integrations.isLoading ? <Loading what="integrations" /> : null}
        {integrations.error ? <ErrorNote error={integrations.error} /> : null}
        {integrations.data && !integrations.data.length ? <p className="note">Nowhere yet. Add an integration, then give its URL and secret to where your code lives.</p> : null}
        {integrations.data?.length ? (
          <ul className="hooks">
            {integrations.data.map((i) => (
              <IntegrationCard key={i.id} integration={i} projectNames={names} />
            ))}
          </ul>
        ) : null}
      </section>
      <div className="tw:grid tw:grid-cols-[repeat(auto-fit,minmax(min(100%,24rem),1fr))] tw:items-start tw:gap-x-4">
        <AddIntegration />
        <section className="card" aria-labelledby="vcs-how">
          <h2 id="vcs-how">How it works</h2>
          <dl className="facts-list">
            <div className="pair">
              <dt>Linked</dt>
              <dd>A commit whose message mentions BACK-12 is linked to it; a pull or merge request, by its title, branch or description. Each shows on the issue, and in its history.</dd>
            </div>
            <div className="pair">
              <dt>Commands</dt>
              <dd>
                <code>BACK-12 #Fixed</code> or <code>BACK-12 #State Fixed Assignee anna</code> applies what follows <code>#</code>, as the commit's author: only when a4a knows them
                and they can change the project's issues. Otherwise the commit is linked, and the issue says why the command wasn't applied.
              </dd>
            </div>
            <div className="pair">
              <dt>Who wrote it</dt>
              <dd>
                The person whose confirmed email the commit names, or whose login at the provider it names: GitHub, Gitea and Bitbucket name the account they matched the
                commit's email to. People confirm their emails on <Link to="/me">their profile</Link>; logins are recorded under <Link to="/admin">Administration</Link>. When the
                email and the login name two people, it's nobody.
              </dd>
            </div>
            <div className="pair">
              <dt>Checked, every time</dt>
              <dd>
                An HMAC-SHA256 of each delivery with the secret (GitHub's <code>X-Hub-Signature-256</code>, Bitbucket's <code>X-Hub-Signature</code>, Gitea's and Forgejo's
                own), or GitLab's <code>X-Gitlab-Token</code>. What fails is refused, and logged here.
              </dd>
            </div>
            <div className="pair">
              <dt>Bitbucket's commits</dt>
              <dd>
                Bitbucket Cloud sends the latest five commits a push gives a branch, and Data Center none: with an access token, a4a reads the rest from Bitbucket. The token is
                never shown again.
              </dd>
            </div>
            <div className="pair">
              <dt>Once</dt>
              <dd>A delivery sent again is answered as one a4a had already, and changes nothing.</dd>
            </div>
          </dl>
        </section>
      </div>
    </AdminOnly>
  );
}

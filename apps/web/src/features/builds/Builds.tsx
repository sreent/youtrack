/**
 * CI builds (docs/architecture.md, D46): where they come from (on the Integrations page), a
 * project's builds and what each did, the builds an issue is in, and the code-host accounts a
 * person connects on their profile.
 */
import type { Build, BuildIssueOutcome, BuildSource, BuildSourceCreated, BuildStatus, CodeHostInfo, IssueBuild, IssueDetail, ProviderLogin, VcsIntegration } from '@a4a/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { del, get, patch, post } from '../../api/client';
import { keys, useMe, useProjects } from '../../api/queries';
import { ago, Badge } from '../../components/Badges';
import { ErrorNote, Loading } from '../../components/States';
import { errorText, FormField, Said, Scroll } from '../common/bits';
import { Confirm } from '../common/Confirm';
import { CopyButton } from '../common/CopyButton';
import { whenRead } from '../common/format';

export const buildKeys = {
  sources: ['build-sources'] as const,
  project: (key: string) => ['projects', key, 'builds'] as const,
};
export const useBuildSources = () => useQuery({ queryKey: buildKeys.sources, queryFn: () => get<BuildSource[]>('/build-sources') });
export const useProjectBuilds = (key: string) => useQuery({ queryKey: buildKeys.project(key), queryFn: () => get<Build[]>(`/projects/${key}/builds?limit=50`) });
/** Under the issue's own key, so the live feed refreshes it with the issue. */
export const useIssueBuilds = (id: string) => useQuery({ queryKey: keys.issueSub(id, 'builds'), queryFn: () => get<IssueBuild[]>(`/issues/${id}/builds`) });

/** How a build ended, in Ocean's grammar. */
export const STATUS: Record<BuildStatus, { tone: 'good' | 'bad' | 'idle'; word: string }> = {
  success: { tone: 'good', word: 'passed' },
  failure: { tone: 'bad', word: 'failed' },
  cancelled: { tone: 'idle', word: 'cancelled' },
};

/** What a build did to an issue. */
export const OUTCOME: Record<BuildIssueOutcome, { tone: 'good' | 'warn' | 'bad' | 'idle'; word: string }> = {
  marked: { tone: 'good', word: 'fixed in it' },
  already: { tone: 'idle', word: 'in an earlier build' },
  open: { tone: 'warn', word: 'not resolved yet' },
  refused: { tone: 'bad', word: 'not marked' },
};

const safe = (url: string | null): string | null => (url && /^https?:\/\//i.test(url) ? url : null);

/** The curl line a CI step posts its build with: the commits since the last build, from git log. */
function curlFor(made: BuildSourceCreated): string {
  return [
    `curl -fsS -X POST '${made.hookUrl}' \\`,
    `  -H "Authorization: Bearer $A4A_BUILD_TOKEN" -H 'Content-Type: application/json' \\`,
    `  -d "{\\"build\\": \\"$BUILD_NUMBER\\", \\"status\\": \\"success\\", \\"url\\": \\"$BUILD_URL\\", \\"commits\\": $(git log --format=%H "$PREVIOUS_SHA..HEAD" | jq -R . | jq -sc .)}"`,
  ].join('\n');
}

function TokenOnce({ made, onKept }: { made: BuildSourceCreated; onKept: () => void }) {
  return (
    <div className="secret" role="status">
      <p>
        <strong>Copy the token now.</strong> This is the only time a4a shows it. The CI sends it with each build, as <code>Authorization: Bearer</code>, and a4a refuses any build
        without it.
      </p>
      <code>{made.hookUrl}</code>
      <code>{made.token}</code>
      <div className="cluster">
        <CopyButton text={made.hookUrl ?? ''} label="Copy the URL" what="the URL" />
        <CopyButton text={made.token ?? ''} label="Copy the token" what="the token" />
        <button type="button" className="link" onClick={onKept}>
          I've kept it
        </button>
      </div>
      <p className="note">A step at the end of a successful build, with the token in the CI's secrets as A4A_BUILD_TOKEN:</p>
      <pre className="mono">{curlFor(made)}</pre>
    </div>
  );
}

function SourceCard({ source, onSaid }: { source: BuildSource; onSaid: (s: { text: string; bad?: boolean }) => void }) {
  const qc = useQueryClient();
  const [made, setMade] = useState<BuildSourceCreated | null>(null);
  const refresh = () => void qc.invalidateQueries({ queryKey: buildKeys.sources });
  const pause = useMutation({
    mutationFn: () => patch<BuildSource>(`/build-sources/${source.id}`, { active: !source.active }),
    onSuccess: (s) => {
      refresh();
      onSaid({ text: s.active ? `${s.name} takes builds again.` : `${s.name} is paused: builds it's sent are refused politely, and recorded nowhere.` });
    },
    onError: (e) => onSaid({ text: errorText(e), bad: true }),
  });
  const rotate = useMutation({ mutationFn: () => post<BuildSourceCreated>(`/build-sources/${source.id}/token`, {}), onSuccess: (m) => (setMade(m), refresh()), onError: (e) => onSaid({ text: errorText(e), bad: true }) });
  const remove = useMutation({ mutationFn: () => del(`/build-sources/${source.id}`), onSuccess: refresh, onError: (e) => onSaid({ text: errorText(e), bad: true }) });
  const from =
    source.kind === 'github'
      ? `${source.integration?.name ?? 'a GitHub integration'}'s runs of ${source.workflow ?? 'any workflow'} on ${source.branch ?? 'any branch'}`
      : `any CI, with its token (it begins ${source.tokenPrefix ?? '…'})`;
  return (
    <li className="card hook">
      <div className="hook-head">
        <div className="hook-what">
          <span className="hook-url">{source.name}</span>
          <span className="item-about">
            Builds of <Link to={`/builds/${source.project}`}>{source.project}</Link> from {from} · into {source.field ?? 'no build field yet'}
            {source.lastBuildAt ? ` · last build ${ago(source.lastBuildAt)}` : ' · no build yet'}
          </span>
        </div>
        {source.active ? <Badge tone="good">takes builds</Badge> : <Badge tone="idle">paused</Badge>}
      </div>
      {source.hookUrl ? (
        <div className="cluster">
          <span className="note">Where builds go</span>
          <code className="hook-url">{source.hookUrl}</code>
          <CopyButton text={source.hookUrl} label="Copy it" what="the URL" />
        </div>
      ) : null}
      <div className="cluster">
        <button type="button" onClick={() => pause.mutate()} disabled={pause.isPending}>
          {source.active ? 'Pause it' : 'Take builds again'}
        </button>
        {source.kind === 'generic' ? (
          <Confirm small label="Give it a new token" title={`A new token for ${source.name}?`} about="The old one stops working at once: give the CI the new one." confirm="Give it a new token" onConfirm={() => rotate.mutate()} />
        ) : null}
        <Confirm small label="Remove" name={`Remove ${source.name}`} title={`Remove ${source.name}?`} about="Its builds stay, with what they marked." confirm="Remove it" onConfirm={() => remove.mutate()} />
      </div>
      {made ? <TokenOnce made={made} onKept={() => setMade(null)} /> : null}
    </li>
  );
}

function AddSource({ integrations }: { integrations: VcsIntegration[] }) {
  const qc = useQueryClient();
  const projects = (useProjects().data ?? []).filter((p) => !p.archived);
  const github = integrations.filter((i) => i.provider === 'github');
  const [kind, setKind] = useState<'generic' | 'github'>('generic');
  const [name, setName] = useState('');
  const [project, setProject] = useState('');
  const [integration, setIntegration] = useState('');
  const [branch, setBranch] = useState('main');
  const [workflow, setWorkflow] = useState('');
  const [made, setMade] = useState<BuildSourceCreated | null>(null);
  const add = useMutation({
    mutationFn: () =>
      post<BuildSourceCreated>('/build-sources', {
        kind,
        name: name.trim(),
        project,
        ...(kind === 'github' ? { integration, branch: branch.trim() || null, workflow: workflow.trim() || null } : {}),
      }),
    onSuccess: (m) => {
      void qc.invalidateQueries({ queryKey: buildKeys.sources });
      setName('');
      if (m.token) setMade(m);
    },
  });
  return (
    <section className="card" aria-labelledby="add-builds">
      <h2 id="add-builds">Take a project's builds</h2>
      <form
        className="form"
        onSubmit={(e) => {
          e.preventDefault();
          add.mutate();
        }}
      >
        <fieldset className="choice-group">
          <legend>From</legend>
          <label className="choice">
            <input type="radio" name="build-kind" checked={kind === 'generic'} onChange={() => setKind('generic')} />
            <span>Any CI, posting each build</span>
          </label>
          <label className="choice">
            <input type="radio" name="build-kind" checked={kind === 'github'} onChange={() => setKind('github')} disabled={!github.length} />
            <span>GitHub Actions{github.length ? '' : ' (add a GitHub integration first)'}</span>
          </label>
        </fieldset>
        <div className="form-fields">
          <FormField label="Name" help="What it is, e.g. Jenkins: backend.">
            {(id, help) => <input id={id} aria-describedby={help} required maxLength={120} value={name} onChange={(e) => setName(e.target.value)} />}
          </FormField>
          <FormField label="Builds of the project" help="Its builds go in its build field: “Fixed in build”, made for it if it has none.">
            {(id, help) => (
              <select id={id} aria-describedby={help} required value={project} onChange={(e) => setProject(e.target.value)}>
                <option value="">Choose a project</option>
                {projects.map((p) => (
                  <option key={p.id} value={p.key}>
                    {p.name}
                  </option>
                ))}
              </select>
            )}
          </FormField>
          {kind === 'github' ? (
            <>
              <FormField label="The GitHub integration">
                {(id) => (
                  <select id={id} required value={integration} onChange={(e) => setIntegration(e.target.value)}>
                    <option value="">Choose one</option>
                    {github.map((i) => (
                      <option key={i.id} value={i.id}>
                        {i.name}
                      </option>
                    ))}
                  </select>
                )}
              </FormField>
              <FormField label="Its branch" help="Only runs on it are builds. Empty: any.">
                {(id, help) => <input id={id} className="mono" aria-describedby={help} value={branch} onChange={(e) => setBranch(e.target.value)} />}
              </FormField>
              <FormField label="Its workflow" help="By name, or its file, such as ci.yml. Empty: any, its builds named with the workflow.">
                {(id, help) => <input id={id} className="mono" aria-describedby={help} value={workflow} onChange={(e) => setWorkflow(e.target.value)} />}
              </FormField>
            </>
          ) : null}
        </div>
        <div className="cluster">
          <button type="submit" className="primary" disabled={add.isPending || !name.trim() || !project || (kind === 'github' && !integration)}>
            {add.isPending ? 'Adding…' : 'Take its builds'}
          </button>
        </div>
        {add.error ? <ErrorNote error={add.error} /> : null}
      </form>
      {made ? <TokenOnce made={made} onKept={() => setMade(null)} /> : null}
    </section>
  );
}

/** The Integrations page's builds: where they come from, and adding a source. */
export function BuildSources({ integrations }: { integrations: VcsIntegration[] }) {
  const sources = useBuildSources();
  const [said, setSaid] = useState<{ text: string; bad?: boolean } | null>(null);
  return (
    <>
      <section className="card" aria-labelledby="build-sources">
        <h2 id="build-sources">Builds</h2>
        <p className="note section-note">
          A build that passes goes in its project's build field, and the resolved issues its commits name are marked as fixed in it, as the build source, in their history.
        </p>
        {sources.isLoading ? <Loading what="build sources" /> : null}
        {sources.error ? <ErrorNote error={sources.error} /> : null}
        {sources.data && !sources.data.length ? <p className="note">No builds come in yet.</p> : null}
        {sources.data?.length ? (
          <ul className="hooks">
            {sources.data.map((s) => (
              <SourceCard key={s.id} source={s} onSaid={setSaid} />
            ))}
          </ul>
        ) : null}
        <Said text={said?.text} tone={said?.bad ? 'bad' : undefined} />
      </section>
      <AddSource integrations={integrations} />
    </>
  );
}

/** A project's builds, newest first, with what each did to the issues its commits name. */
export function BuildList({ project }: { project: string }) {
  const list = useProjectBuilds(project);
  if (list.isLoading) return <Loading what="its builds" />;
  if (list.error) return <ErrorNote error={list.error} />;
  if (!list.data?.length) return <p className="note">No builds yet. An administrator takes a project's builds from CI under Integrations.</p>;
  return (
    <Scroll label="Table of builds">
      <table className="figures middle">
        <thead>
          <tr>
            <th scope="col">Build</th>
            <th scope="col">How it ended</th>
            <th scope="col">Fixed in it</th>
            <th scope="col">Commits</th>
          </tr>
        </thead>
        <tbody>
          {list.data.map((b) => (
            <tr key={b.id}>
              <th scope="row" className="row-head">
                {safe(b.url) ? (
                  <a className="item-name mono" href={safe(b.url)!} target="_blank" rel="noreferrer noopener">
                    {b.name}
                  </a>
                ) : (
                  <span className="item-name mono">{b.name}</span>
                )}
                <span className="item-about">
                  {[b.source?.name, b.branch, b.finishedAt ? whenRead(b.finishedAt) : null].filter(Boolean).join(' · ')}
                </span>
              </th>
              <td>
                <Badge tone={STATUS[b.status].tone}>{STATUS[b.status].word}</Badge>
              </td>
              <td>
                {b.issues.length ? (
                  <ul className="chips" aria-label={`What build ${b.name} did`}>
                    {b.issues.map((i) => (
                      <li key={i.issue.id} className="chip" title={i.note ?? OUTCOME[i.outcome].word}>
                        <Link to={`/issues/${i.issue.id}`} className="issue-id">
                          {i.issue.id}
                        </Link>{' '}
                        <span className="item-about">{OUTCOME[i.outcome].word}</span>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <span className="note">None</span>
                )}
              </td>
              <td className="num">{b.commits}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </Scroll>
  );
}

/** The builds an issue is in, under its commits: which one it was fixed in, and any that found it open. */
export function IssueBuilds({ issue }: { issue: IssueDetail }) {
  const list = useIssueBuilds(issue.id);
  if (!list.data?.length) return null;
  return (
    <div className="stack tight" role="group" aria-label="Builds">
      <p className="note">Builds</p>
      <ul className="code-list">
        {list.data.map((b) => (
          <li key={b.build}>
            <p className="code-line">
              {safe(b.url) ? (
                <a className="code-ref" href={safe(b.url)!} target="_blank" rel="noreferrer noopener">
                  <span className="hidden">Build </span>
                  {b.build}
                </a>
              ) : (
                <span className="code-ref">{b.build}</span>
              )}
              <Badge tone={OUTCOME[b.outcome].tone}>{OUTCOME[b.outcome].word}</Badge>
              {b.status !== 'success' ? <Badge tone={STATUS[b.status].tone}>{STATUS[b.status].word}</Badge> : null}
            </p>
            {b.note || b.finishedAt ? <p className="item-about">{[b.note, b.finishedAt ? whenRead(b.finishedAt) : null].filter(Boolean).join(' · ')}</p> : null}
          </li>
        ))}
      </ul>
      <p className="note">
        <Link to={`/builds/${issue.project.key}`}>All of {issue.project.key}'s builds</Link>
      </p>
    </div>
  );
}

const CONNECT_SAID: Record<string, string> = {
  expired: 'The sign-in there took too long, or was started elsewhere. Connect again.',
  mismatch: 'It came back to someone other than who started it. Connect again, signed in as yourself.',
  denied: 'You said no there, so nothing is connected.',
  taken: "That account is someone else's in a4a. An administrator can move it.",
  refused: "The provider didn't say who you are. Try again, or ask an administrator to look at its app.",
  unreachable: "a4a couldn't reach the provider. Try again later.",
  failed: 'Something went wrong. Try again.',
};

/** Your accounts at code hosts, on your profile: connected by signing in there, and disconnected here. */
export function CodeHostAccounts() {
  const qc = useQueryClient();
  const me = useMe();
  const meId = me.data?.id ?? '';
  const [params, setParams] = useSearchParams();
  const hosts = useQuery({ queryKey: ['me', 'code-hosts'], queryFn: () => get<CodeHostInfo[]>('/me/code-hosts') });
  const logins = useQuery({ queryKey: ['users', meId, 'provider-logins'], queryFn: () => get<ProviderLogin[]>(`/users/${meId}/provider-logins`), enabled: Boolean(meId) });
  const [said, setSaid] = useState<{ text: string; bad?: boolean } | null>(null);
  useEffect(() => {
    const connected = params.get('connected');
    const failure = params.get('connect');
    if (!connected && !failure) return;
    setSaid(connected ? { text: `Your ${hosts.data?.find((h) => h.provider === connected)?.name ?? connected} account is connected: its commits and pull requests are yours.` } : { text: CONNECT_SAID[failure!] ?? CONNECT_SAID.failed!, bad: true });
    params.delete('connected');
    params.delete('connect');
    setParams(params, { replace: true });
  }, [params, setParams, hosts.data]);
  const connect = useMutation({
    mutationFn: (provider: string) => post<{ url: string }>(`/me/code-hosts/${provider}/connect`, {}),
    onSuccess: ({ url }) => window.location.assign(url),
    onError: (e) => setSaid({ text: errorText(e), bad: true }),
  });
  const disconnect = useMutation({
    mutationFn: (l: ProviderLogin) => del(`/users/${meId}/provider-logins/${l.id}`),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['users', meId, 'provider-logins'] });
      setSaid({ text: "Disconnected: commits under that account aren't yours from now on." });
    },
    onError: (e) => setSaid({ text: errorText(e), bad: true }),
  });
  const available = (hosts.data ?? []).filter((h) => h.available);
  const connected = (logins.data ?? []).filter((l) => l.connected);
  if (!available.length && !connected.length) return null;
  return (
    <section className="card" aria-labelledby="code-hosts-title" id="code-hosts">
      <h2 id="code-hosts-title">Your accounts at code hosts</h2>
      <p className="note section-note">
        Connect an account by signing in there: its commits and pull requests are yours in a4a, and the commands in them run as you. a4a asks who you are once, and keeps no token.
      </p>
      {connected.length ? (
        <ul className="stack tight" aria-label="Connected accounts">
          {connected.map((l) => (
            <li key={l.id} className="cluster spread">
              <span>
                {hosts.data?.find((h) => h.provider === l.provider)?.name ?? l.provider} <span className="mono">{l.login}</span>
              </span>
              <Confirm small label="Disconnect" name={`Disconnect ${l.login}`} title={`Disconnect ${l.login}?`} about="Commits under it won't be yours from now on. Those linked already stay." confirm="Disconnect it" onConfirm={() => disconnect.mutate(l)} />
            </li>
          ))}
        </ul>
      ) : null}
      <div className="cluster">
        {available.map((h) => (
          <button key={h.provider} type="button" onClick={() => connect.mutate(h.provider)} disabled={connect.isPending}>
            Connect {h.name}
          </button>
        ))}
      </div>
      <Said text={said?.text} tone={said?.bad ? 'bad' : undefined} />
    </section>
  );
}

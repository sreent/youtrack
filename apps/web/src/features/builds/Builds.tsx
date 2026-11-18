/**
 * CI builds (docs/architecture.md, D46): where they come from (on the Integrations page), a
 * project's builds and what each did, the builds an issue is in, and the code-host accounts a
 * person connects on their profile.
 */
import type { Build, BuildIssueOutcome, BuildSource, BuildSourceCreated, BuildStatus, CodeHostInfo, IssueBuild, IssueDetail, NoteSaid, ProviderLogin, VcsIntegration } from '@a4a/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { del, get, patch, post } from '../../api/client';
import { keys, useMe, useProjects } from '../../api/queries';
import { agoSaid, Badge } from '../../components/Badges';
import { ErrorNote, Loading } from '../../components/States';
import { errorText, FormField, Said, Scroll } from '../common/bits';
import { Confirm } from '../common/Confirm';
import { CopyButton } from '../common/CopyButton';
import { whenRead } from '../common/format';
import { canSay, problemWords, t, tr } from '../../i18n';
import type { ReactNode } from 'react';

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
  success: { tone: 'good', word: t('builds.builds.passed') },
  failure: { tone: 'bad', word: t('builds.builds.failed') },
  cancelled: { tone: 'idle', word: t('builds.builds.cancelled') },
};

/** What a build did to an issue. */
export const OUTCOME: Record<BuildIssueOutcome, { tone: 'good' | 'warn' | 'bad' | 'idle'; word: string }> = {
  marked: { tone: 'good', word: t('builds.builds.fixedInIt2') },
  already: { tone: 'idle', word: t('builds.builds.inAnEarlierBuild') },
  open: { tone: 'warn', word: t('builds.builds.notResolvedYet') },
  refused: { tone: 'bad', word: t('builds.builds.notMarked') },
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
      <p>{tr('builds.builds.copyTheTokenNowThis', { t0: (c: ReactNode) => <strong>{c}</strong>, code: <code>Authorization: Bearer</code> })}</p>
      <code>{made.hookUrl}</code>
      <code>{made.token}</code>
      <div className="cluster">
        <CopyButton text={made.hookUrl ?? ''} label={t('builds.builds.copyTheUrl')} what={t('builds.builds.theUrl')} />
        <CopyButton text={made.token ?? ''} label={t('builds.builds.copyTheToken')} what={t('builds.builds.theToken')} />
        <button type="button" className="link" onClick={onKept}>{t('builds.builds.iVeKeptIt')}</button>
      </div>
      <p className="note">{t('builds.builds.aStepAtTheEnd')}</p>
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
      onSaid({ text: s.active ? t('builds.builds.takesBuildsAgain', { name: s.name }) : t('builds.builds.isPausedBuildsItS', { name: s.name }) });
    },
    onError: (e) => onSaid({ text: errorText(e), bad: true }),
  });
  const rotate = useMutation({ mutationFn: () => post<BuildSourceCreated>(`/build-sources/${source.id}/token`, {}), onSuccess: (m) => (setMade(m), refresh()), onError: (e) => onSaid({ text: errorText(e), bad: true }) });
  const remove = useMutation({ mutationFn: () => del(`/build-sources/${source.id}`), onSuccess: refresh, onError: (e) => onSaid({ text: errorText(e), bad: true }) });
  const runsOf = (unnamed: string) =>
    t('builds.builds.sRunsOfOn', { v: source.integration?.name ?? unnamed, v2: source.workflow ?? t('builds.builds.anyWorkflow'), v3: source.branch ?? t('builds.builds.anyBranch') });
  const from =
    source.kind === 'github'
      ? runsOf(t('builds.builds.aGithubIntegration'))
      : source.kind === 'gitea'
        ? runsOf(t('builds.builds.aGiteaIntegration'))
        : t('builds.builds.anyCiWithItsToken', { v: source.tokenPrefix ?? '…' });
  return (
    <li className="card hook">
      <div className="hook-head">
        <div className="hook-what">
          <span className="hook-url">{source.name}</span>
          <span className="item-about">{tr('builds.builds.buildsOfFromInto', { project: source.project, t0: (c: ReactNode) => <Link to={`/builds/${source.project}`}>{c}</Link>, from: from, v: source.field ?? t('builds.builds.noBuildFieldYet'), v2: source.lastBuildAt ? t('builds.builds.lastBuild', { when: agoSaid(source.lastBuildAt) }) : t('builds.builds.noBuildYet') })}</span>
        </div>
        {source.active ? <Badge tone="good">{t('builds.builds.takesBuilds')}</Badge> : <Badge tone="idle">{t('builds.builds.paused')}</Badge>}
      </div>
      {source.hookUrl ? (
        <div className="cluster">
          <span className="note">{t('builds.builds.whereBuildsGo')}</span>
          <code className="hook-url">{source.hookUrl}</code>
          <CopyButton text={source.hookUrl} label={t('builds.builds.copyIt')} what={t('builds.builds.theUrl')} />
        </div>
      ) : null}
      <div className="cluster">
        <button type="button" onClick={() => pause.mutate()} disabled={pause.isPending}>
          {source.active ? t('builds.builds.pauseIt') : t('builds.builds.takeBuildsAgain')}
        </button>
        {source.kind === 'generic' ? (
          <Confirm small label={t('builds.builds.giveItANewToken')} title={t('builds.builds.aNewTokenFor', { name: source.name })} about={t('builds.builds.theOldOneStopsWorking')} confirm={t('builds.builds.giveItANewToken')} onConfirm={() => rotate.mutate()} />
        ) : null}
        <Confirm small label={t('builds.builds.remove')} name={t('builds.builds.remove3', { name: source.name })} title={t('builds.builds.remove2', { name: source.name })} about={t('builds.builds.itsBuildsStayWithWhat')} confirm={t('builds.builds.removeIt')} onConfirm={() => remove.mutate()} />
      </div>
      {made ? <TokenOnce made={made} onKept={() => setMade(null)} /> : null}
    </li>
  );
}

function AddSource({ integrations }: { integrations: VcsIntegration[] }) {
  const qc = useQueryClient();
  const projects = (useProjects().data ?? []).filter((p) => !p.archived);
  const github = integrations.filter((i) => i.provider === 'github');
  // Gitea's and Forgejo's: a4a's one provider for both (D33), whose Actions runs come as GitHub's do (D55).
  const gitea = integrations.filter((i) => i.provider === 'gitea');
  const [kind, setKind] = useState<'generic' | 'github' | 'gitea'>('generic');
  const runs = kind === 'github' ? github : kind === 'gitea' ? gitea : [];
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
        ...(kind !== 'generic' ? { integration, branch: branch.trim() || null, workflow: workflow.trim() || null } : {}),
      }),
    onSuccess: (m) => {
      void qc.invalidateQueries({ queryKey: buildKeys.sources });
      setName('');
      if (m.token) setMade(m);
    },
  });
  return (
    <section className="card" aria-labelledby="add-builds">
      <h2 id="add-builds">{t('builds.builds.takeAProjectSBuilds')}</h2>
      <form
        className="form"
        onSubmit={(e) => {
          e.preventDefault();
          add.mutate();
        }}
      >
        <fieldset className="choice-group">
          <legend>{t('builds.builds.from')}</legend>
          <label className="choice">
            <input type="radio" name="build-kind" checked={kind === 'generic'} onChange={() => (setKind('generic'), setIntegration(''))} />
            <span>{t('builds.builds.anyCiPostingEachBuild')}</span>
          </label>
          <label className="choice">
            <input type="radio" name="build-kind" checked={kind === 'github'} onChange={() => (setKind('github'), setIntegration(''))} disabled={!github.length} />
            <span>{tr('builds.builds.githubActions', { v: github.length ? '' : t('builds.builds.addAGithubIntegrationFirst') })}</span>
          </label>
          <label className="choice">
            <input type="radio" name="build-kind" checked={kind === 'gitea'} onChange={() => (setKind('gitea'), setIntegration(''))} disabled={!gitea.length} />
            <span>{tr('builds.builds.forgejoActions', { v: gitea.length ? '' : t('builds.builds.addAGiteaIntegrationFirst') })}</span>
          </label>
        </fieldset>
        <div className="form-fields">
          <FormField label={t('builds.builds.name')} help={t('builds.builds.whatItIsEG')}>
            {(id, help) => <input id={id} aria-describedby={help} required maxLength={120} value={name} onChange={(e) => setName(e.target.value)} />}
          </FormField>
          <FormField label={t('builds.builds.buildsOfTheProject')} help={t('builds.builds.itsBuildsGoInIts')}>
            {(id, help) => (
              <select id={id} aria-describedby={help} required value={project} onChange={(e) => setProject(e.target.value)}>
                <option value="">{t('builds.builds.chooseAProject')}</option>
                {projects.map((p) => (
                  <option key={p.id} value={p.key}>
                    {p.name}
                  </option>
                ))}
              </select>
            )}
          </FormField>
          {kind !== 'generic' ? (
            <>
              <FormField label={kind === 'github' ? t('builds.builds.theGithubIntegration') : t('builds.builds.theGiteaIntegration')}>
                {(id) => (
                  <select id={id} required value={integration} onChange={(e) => setIntegration(e.target.value)}>
                    <option value="">{t('builds.builds.chooseOne')}</option>
                    {runs.map((i) => (
                      <option key={i.id} value={i.id}>
                        {i.name}
                      </option>
                    ))}
                  </select>
                )}
              </FormField>
              <FormField label={t('builds.builds.itsBranch')} help={t('builds.builds.onlyRunsOnItAre')}>
                {(id, help) => <input id={id} className="mono" aria-describedby={help} value={branch} onChange={(e) => setBranch(e.target.value)} />}
              </FormField>
              <FormField label={t('builds.builds.itsWorkflow')} help={kind === 'github' ? t('builds.builds.byNameOrItsFile') : t('builds.builds.byItsFileSuchAs')}>
                {(id, help) => <input id={id} className="mono" aria-describedby={help} value={workflow} onChange={(e) => setWorkflow(e.target.value)} />}
              </FormField>
            </>
          ) : null}
        </div>
        <div className="cluster">
          <button type="submit" className="primary" disabled={add.isPending || !name.trim() || !project || (kind !== 'generic' && !integration)}>
            {add.isPending ? t('builds.builds.adding') : t('builds.builds.takeItsBuilds')}
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
        <h2 id="build-sources">{t('builds.builds.builds')}</h2>
        <p className="note section-note">{t('builds.builds.aBuildThatPassesGoes')}</p>
        {sources.isLoading ? <Loading what="loadingLine.buildSources" /> : null}
        {sources.error ? <ErrorNote error={sources.error} /> : null}
        {sources.data && !sources.data.length ? <p className="note">{t('builds.builds.noBuildsComeInYet')}</p> : null}
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
  if (list.isLoading) return <Loading what="loadingLine.projectBuilds" />;
  if (list.error) return <ErrorNote error={list.error} />;
  if (!list.data?.length) return <p className="note">{t('builds.builds.noBuildsYetAnAdministrator')}</p>;
  return (
    <Scroll label={t('builds.builds.tableOfBuilds')}>
      <table className="figures middle">
        <thead>
          <tr>
            <th scope="col">{t('builds.builds.build')}</th>
            <th scope="col">{t('builds.builds.howItEnded')}</th>
            <th scope="col">{t('builds.builds.fixedInIt')}</th>
            <th scope="col">{t('builds.builds.commits')}</th>
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
                  <ul className="chips" aria-label={t('builds.builds.whatBuildDid', { name: b.name })}>
                    {b.issues.map((i) => (
                      <li key={i.issue.id} className="chip" title={noteOf(i) ?? OUTCOME[i.outcome].word}>
                        <Link to={`/issues/${i.issue.id}`} className="issue-id">
                          {i.issue.id}
                        </Link>{' '}
                        <span className="item-about">{OUTCOME[i.outcome].word}</span>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <span className="note">{t('builds.builds.none')}</span>
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

/**
 * Why a build left an issue as it did, in the page's language, from the words a4a kept with the note
 * (D49). A refusal is said as the problem it was. One recorded before a4a kept them, or one no catalog
 * has, is the note's English.
 */
function noteOf(x: { note: string | null; said: NoteSaid | null }): string | null {
  const said = x.said;
  if (!said) return x.note;
  if (said.key.startsWith('problem.')) return problemWords({ key: said.key.slice('problem.'.length), values: said.values }) ?? x.note;
  return canSay(said.key) ? t(said.key, said.values) : x.note;
}

/** The builds an issue is in, under its commits: which one it was fixed in, and any that found it open. */
export function IssueBuilds({ issue }: { issue: IssueDetail }) {
  const list = useIssueBuilds(issue.id);
  if (!list.data?.length) return null;
  return (
    <div className="stack tight" role="group" aria-label={t('builds.builds.builds')}>
      <p className="note">{t('builds.builds.builds')}</p>
      <ul className="code-list">
        {list.data.map((b) => (
          <li key={b.build}>
            <p className="code-line">
              {safe(b.url) ? (
                <a className="code-ref" href={safe(b.url)!} target="_blank" rel="noreferrer noopener">
                  <span className="hidden">{t('builds.builds.build2')}</span>
                  {b.build}
                </a>
              ) : (
                <span className="code-ref">{b.build}</span>
              )}
              <Badge tone={OUTCOME[b.outcome].tone}>{OUTCOME[b.outcome].word}</Badge>
              {b.status !== 'success' ? <Badge tone={STATUS[b.status].tone}>{STATUS[b.status].word}</Badge> : null}
            </p>
            {b.note || b.finishedAt ? <p className="item-about">{[noteOf(b), b.finishedAt ? whenRead(b.finishedAt) : null].filter(Boolean).join(' · ')}</p> : null}
          </li>
        ))}
      </ul>
      <p className="note">
        <Link to={`/builds/${issue.project.key}`}>{tr('builds.builds.allOfSBuilds', { key: issue.project.key })}</Link>
      </p>
    </div>
  );
}

const CONNECT_SAID: Record<string, string> = {
  expired: t('builds.builds.theSignInThereTook'),
  mismatch: t('builds.builds.itCameBackToSomeone'),
  denied: t('builds.builds.youSaidNoThereSo'),
  taken: t('builds.builds.thatAccountIsSomeoneElse'),
  refused: t('builds.builds.theProviderDidnTSay'),
  unreachable: t('builds.builds.a4aCouldnTReachThe'),
  failed: t('builds.builds.somethingWentWrongTryAgain'),
};

/** Your accounts at code hosts, on your profile: connected by signing in there, and disconnected here. */
export function CodeHostAccounts() {
  const qc = useQueryClient();
  const me = useMe();
  const meId = me.data?.id ?? '';
  const [params, setParams] = useSearchParams();
  const hosts = useQuery({ queryKey: ['me', 'code-hosts'], queryFn: () => get<CodeHostInfo[]>('/me/code-hosts') });
  const logins = useQuery({ queryKey: ['users', meId, 'provider-logins'], queryFn: () => get<ProviderLogin[]>(`/users/${meId}/provider-logins`), enabled: Boolean(meId) });
  const [said, setSaid] = useState<{ text: string; bad?: boolean } | { connected: string } | null>(null);
  useEffect(() => {
    const connected = params.get('connected');
    const failure = params.get('connect');
    if (!connected && !failure) return;
    // The host is named once its name has loaded: the page is back from it before the list is.
    setSaid(connected ? { connected } : { text: CONNECT_SAID[failure!] ?? CONNECT_SAID.failed!, bad: true });
    params.delete('connected');
    params.delete('connect');
    setParams(params, { replace: true });
  }, [params, setParams]);
  const shown = said && 'connected' in said ? { text: t('builds.builds.yourAccountIsConnectedIts', { v: hosts.data?.find((h) => h.provider === said.connected)?.name ?? said.connected }) } : said;
  const connect = useMutation({
    mutationFn: (provider: string) => post<{ url: string }>(`/me/code-hosts/${provider}/connect`, {}),
    onSuccess: ({ url }) => window.location.assign(url),
    onError: (e) => setSaid({ text: errorText(e), bad: true }),
  });
  const disconnect = useMutation({
    mutationFn: (l: ProviderLogin) => del(`/users/${meId}/provider-logins/${l.id}`),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['users', meId, 'provider-logins'] });
      setSaid({ text: t('builds.builds.disconnectedCommitsUnderThatAccount') });
    },
    onError: (e) => setSaid({ text: errorText(e), bad: true }),
  });
  const available = (hosts.data ?? []).filter((h) => h.available);
  const connected = (logins.data ?? []).filter((l) => l.connected);
  if (!available.length && !connected.length) return null;
  return (
    <section className="card" aria-labelledby="code-hosts-title" id="code-hosts">
      <h2 id="code-hosts-title">{t('builds.builds.yourAccountsAtCodeHosts')}</h2>
      <p className="note section-note">{t('builds.builds.connectAnAccountBySigning')}</p>
      {connected.length ? (
        <ul className="stack tight" aria-label={t('builds.builds.connectedAccounts')}>
          {connected.map((l) => (
            <li key={l.id} className="cluster spread">
              <span>
                {hosts.data?.find((h) => h.provider === l.provider)?.name ?? l.provider} <span className="mono">{l.login}</span>
              </span>
              <Confirm small label={t('builds.builds.disconnect')} name={t('builds.builds.disconnect3', { login: l.login })} title={t('builds.builds.disconnect2', { login: l.login })} about={t('builds.builds.commitsUnderItWonT')} confirm={t('builds.builds.disconnectIt')} onConfirm={() => disconnect.mutate(l)} />
            </li>
          ))}
        </ul>
      ) : null}
      <div className="cluster">
        {available.map((h) => (
          <button key={h.provider} type="button" onClick={() => connect.mutate(h.provider)} disabled={connect.isPending}>{tr('builds.builds.connect', { name: h.name })}</button>
        ))}
      </div>
      <Said text={shown?.text} tone={shown && 'bad' in shown && shown.bad ? 'bad' : undefined} />
    </section>
  );
}

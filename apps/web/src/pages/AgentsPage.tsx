import type { ApiToken, Scope } from '@a4a/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { del, post } from '../api/client';
import { keys, useMe, useProjects, useTokens } from '../api/queries';
import { ago, Badge } from '../components/Badges';
import { ErrorNote, Loading, PageHead } from '../components/States';
import { errorText, FormField, Said, Scroll } from '../features/common/bits';
import { Confirm } from '../features/common/Confirm';
import { CopyButton } from '../features/common/CopyButton';
import { dateRead } from '../features/common/format';
import { Hint } from '../features/common/Hint';
import { useAITools, type AITool } from '../features/common/queries';
import { AllowedApps, SignInInstead } from '../features/agents/OAuthApps';
import { AgentAccounts } from '../features/agents/AgentAccounts';
import { t, t as tx, tr } from '../i18n';
import type { ReactNode } from 'react';

type Created = ApiToken & { token: string };
type Client = 'claude-code' | 'http' | 'desktop';

const PLACEHOLDER = 'a4a_your_token';

const SCOPES: { scope: Scope; about: string }[] = [
  { scope: 'read', about: tx('page.agents.searchAndReadIssuesProjects') },
  { scope: 'write', about: tx('page.agents.alsoCreateAndChangeIssues') },
  { scope: 'admin', about: tx('page.agents.alsoChangeProjectsFieldsPeople') },
];

const RESOURCES: { uri: string; about: string }[] = [
  { uri: 'a4a://guide/query-language', about: tx('page.agents.theSearchSyntaxWithExamples') },
  { uri: 'a4a://guide/commands', about: tx('page.agents.theCommandSyntax') },
  { uri: 'a4a://projects/{key}', about: tx('page.agents.aProjectSSchemaIts') },
  { uri: 'a4a://issues/{id}', about: tx('page.agents.anIssueAsMarkdownIts') },
];

const PROMPTS: { name: string; args: string; about: string }[] = [
  {
    name: 'work_on_issue',
    args: 'issue_id',
    about: tx('page.agents.readTheIssueAndIts'),
  },
  {
    name: 'triage_backlog',
    args: 'project',
    about: tx('page.agents.reviewUntriagedIssuesProposeType'),
  },
  { name: 'report_bug', args: 'description', about: tx('page.agents.lookForDuplicatesFirstThen') },
  { name: 'status_report', args: 'project, since?', about: tx('page.agents.progressBlockersAndRisksFrom') },
  { name: 'release_notes', args: 'project, query?', about: tx('page.agents.releaseNotesFromResolvedIssues') },
  {
    name: 'schedule_review',
    args: 'project, baseline?',
    about: tx('page.agents.theCriticalPathPeopleBooked'),
  },
];

function snippet(client: Client, origin: string, token: string): string {
  // not words: a command to paste
  if (client === 'claude-code') return `claude mcp add --transport http a4a ${origin}/mcp --header "Authorization: Bearer ${token}"`;
  if (client === 'http') return JSON.stringify({ mcpServers: { a4a: { url: `${origin}/mcp`, headers: { Authorization: t('page.agents.bearer', { token: token }) } } } }, null, 2);
  return JSON.stringify({ mcpServers: { a4a: { command: 'npx', args: ['a4a-mcp'], env: { A4A_URL: origin, A4A_TOKEN: token } } } }, null, 2);
}

const CLIENTS: { id: Client; label: string; where: string }[] = [
  { id: 'claude-code', label: tx('page.agents.claudeCode'), where: t('page.agents.runThisInATerminal') },
  { id: 'http', label: tx('page.agents.cursorAndOtherHttpClients'), where: t('page.agents.putThisInYourClient') },
  {
    id: 'desktop',
    label: tx('page.agents.claudeDesktop'),
    where: t('page.agents.putThisInClaudeDesktop'),
  },
];

function ToolRow({ tool }: { tool: AITool }) {
  return (
    <li>
      <div className="tool-head">
        <code>{tool.name}</code>
        <strong>{tool.title}</strong>
        <Badge grammar={tool.kind}>{tool.kind}</Badge>
        {tool.destructive ? <span className="chip">{tx('page.agents.canOverwrite')}</span> : null}
      </div>
      <p>{tool.description}</p>
    </li>
  );
}

/** How to let an agent work in a4a over MCP, with a token that says how far it may go. */
export default function AgentsPage() {
  const qc = useQueryClient();
  const me = useMe();
  const tokens = useTokens();
  const tools = useAITools();
  const projects = useProjects();
  const origin = window.location.origin;
  const isAdmin = Boolean(me.data?.auth.scopes.includes('admin'));
  const [name, setName] = useState('claude-code');
  const [scopes, setScopes] = useState<Set<Scope>>(() => new Set<Scope>(['read', 'write']));
  // Every project you can see, or only these (by key).
  const [reach, setReach] = useState<'all' | 'some'>('all');
  const [only, setOnly] = useState<Set<string>>(() => new Set());
  const [expires, setExpires] = useState('90');
  const [created, setCreated] = useState<Created | null>(null);
  const [client, setClient] = useState<Client>('claude-code');
  const [said, setSaid] = useState<{ text: string; bad?: boolean } | null>(null);

  const create = useMutation({
    mutationFn: () =>
      post<Created>('/me/tokens', {
        name: name.trim(),
        scopes: SCOPES.map((s) => s.scope).filter((s) => scopes.has(s)),
        expiresInDays: expires === 'never' ? null : Number(expires),
        ...(reach === 'some' ? { projects: [...only] } : {}),
      }),
    onSuccess: (t) => {
      setCreated(t);
      setSaid(null);
      void qc.invalidateQueries({ queryKey: keys.tokens });
    },
  });
  const revoke = useMutation({
    mutationFn: (t: ApiToken) => del(`/me/tokens/${t.id}`),
    onSuccess: (_, t) => {
      if (created?.id === t.id) setCreated(null);
      setSaid({ text: tx('page.agents.theTokenIsRevokedAnything', { name: t.name }) });
      void qc.invalidateQueries({ queryKey: keys.tokens });
    },
    onError: (e) => setSaid({ text: errorText(e), bad: true }),
  });

  const toggle = (s: Scope) =>
    setScopes((cur) => {
      const next = new Set(cur);
      if (next.has(s)) next.delete(s);
      else next.add(s);
      // Writing means reading too.
      if (s === 'write' && next.has('write')) next.add('read');
      if (s === 'admin' && next.has('admin')) next.add('read');
      return next;
    });
  const pick = (key: string) =>
    setOnly((cur) => {
      const next = new Set(cur);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  // A token limited to projects never administers: administration reaches every project.
  const limitedAdmin = reach === 'some' && scopes.has('admin');
  const noProjects = reach === 'some' && !only.size;

  const token = created?.token ?? PLACEHOLDER;
  const current = CLIENTS.find((c) => c.id === client)!;
  const reads = (tools.data ?? []).filter((t) => t.kind === 'reads');
  const changes = (tools.data ?? []).filter((t) => t.kind === 'changes');

  return (
    <>
      <PageHead
        title={tx('page.agents.agentsAndTokens')}
        about={tx('page.agents.letAnAgentSuchAs')}
      />
      <div className="split">
        <div className="stack">
          <section className="card" aria-labelledby="connect">
            <h2 id="connect">{tx('page.agents.connectAnAgent')}</h2>
            <SignInInstead />
            <ol className="steps">
              <li>
                <h3>{tx('page.agents.createATokenForIt')}</h3>
                <form
                  className="form"
                  onSubmit={(e) => {
                    e.preventDefault();
                    create.mutate();
                  }}
                >
                  <div className="tw:grid tw:grid-cols-[minmax(0,2fr)_minmax(0,1fr)] tw:items-start tw:gap-x-4 tw:gap-y-3 tw:max-[640px]:grid-cols-1">
                    <FormField
                      label={tx('page.agents.name')}
                      help={tx('page.agents.nameItAfterTheAgent', { v: name.trim() || 'claude-code', v2: me.data?.name ?? 'you' })}
                    >
                      {(id, help) => <input id={id} value={name} onChange={(e) => setName(e.target.value)} required maxLength={80} aria-describedby={help} />}
                    </FormField>
                    <FormField label={tx('page.agents.expires')}>
                      {(id) => (
                        <select id={id} value={expires} onChange={(e) => setExpires(e.target.value)}>
                          <option value="30">{tx('page.agents.in30Days')}</option>
                          <option value="90">{tx('page.agents.in90Days')}</option>
                          <option value="365">{tx('page.agents.inAYear')}</option>
                          <option value="never">{tx('page.agents.never')}</option>
                        </select>
                      )}
                    </FormField>
                  </div>
                  <fieldset className="choice-group column">
                    <legend>{tx('page.agents.whatItMayDo')}</legend>
                    {SCOPES.map((s) => {
                      const barred = s.scope === 'admin' && !isAdmin;
                      return (
                        <label key={s.scope} className="choice">
                          <input type="checkbox" checked={scopes.has(s.scope)} onChange={() => toggle(s.scope)} disabled={barred} />
                          <span>
                            <span className="mono">{s.scope}</span>
                            <small className="field-help">{barred ? tx('page.agents.yourRoleCanTGive') : s.about}</small>
                          </span>
                        </label>
                      );
                    })}
                  </fieldset>
                  <fieldset className="choice-group column">
                    <legend>{tx('page.agents.whereItMay')}</legend>
                    <label className="choice">
                      <input type="radio" name="token-reach" checked={reach === 'all'} onChange={() => setReach('all')} />
                      <span>{tr('page.agents.everyProjectYouCanSee', { t0: (c: ReactNode) => <small className="field-help">{c}</small> })}</span>
                    </label>
                    <label className="choice">
                      <input type="radio" name="token-reach" checked={reach === 'some'} onChange={() => setReach('some')} />
                      <span>{tr('page.agents.onlySomeProjectsThereIt', { t0: (c: ReactNode) => <small className="field-help">{c}</small> })}</span>
                    </label>
                  </fieldset>
                  {reach === 'some' ? (
                    <fieldset className="choice-group columns">
                      <legend>{tx('page.agents.itsProjects')}</legend>
                      {(projects.data ?? []).map((p) => (
                        <label key={p.id} className="choice">
                          <input type="checkbox" checked={only.has(p.key)} onChange={() => pick(p.key)} />
                          <span>
                            <span className="mono">{p.key}</span> {p.name}
                          </span>
                        </label>
                      ))}
                    </fieldset>
                  ) : null}
                  <div className="cluster">
                    <button type="submit" className="primary" disabled={create.isPending || !scopes.size || !name.trim() || limitedAdmin || noProjects}>
                      {create.isPending ? tx('page.agents.creating') : tx('page.agents.createTheToken')}
                    </button>
                    {!scopes.size ? <span className="note">{tx('page.agents.chooseAtLeastOneThing')}</span> : null}
                    {noProjects ? <span className="note">{tx('page.agents.chooseAtLeastOneProject')}</span> : null}
                    {limitedAdmin ? <span className="note">{tx('page.agents.aTokenLimitedToProjects')}</span> : null}
                  </div>
                  {create.error ? <ErrorNote error={create.error} /> : null}
                </form>
                {created ? (
                  <div className="secret" role="status">
                    <p>{tr('page.agents.copyItNowThisIs', { t0: (c: ReactNode) => <strong>{c}</strong>, name: created.name })}</p>
                    <code>{created.token}</code>
                    <div className="cluster">
                      <CopyButton text={created.token} label={tx('page.agents.copyTheToken')} what={t('page.agents.theToken')} />
                      <button type="button" className="link" onClick={() => setCreated(null)}>{tx('page.agents.iVeKeptIt')}</button>
                    </div>
                  </div>
                ) : null}
              </li>
              <li>
                <h3>{tx('page.agents.addA4aToTheAgent')}</h3>
                <div className="modes" role="group" aria-label={tx('page.agents.whichAgent')}>
                  {CLIENTS.map((c) => (
                    <button key={c.id} type="button" aria-pressed={client === c.id} onClick={() => setClient(c.id)}>
                      {c.label}
                    </button>
                  ))}
                </div>
                <p className="note">{current.where}</p>
                <div className="stack tight">
                  <pre className="snippet" aria-label={tx('page.agents.for', { label: current.label })}>
                    {snippet(client, origin, token)}
                  </pre>
                  <div className="cluster">
                    <CopyButton text={snippet(client, origin, token)} label={tx('page.agents.copyIt')} what={t('page.agents.theSetupFor', { label: current.label })} />
                    <span className="note">
                      {created ? tx('page.agents.itHasTheTokenIn', { name: created.name }) : tx('page.agents.createATokenAboveAnd', { PLACEHOLDER: PLACEHOLDER })}
                    </span>
                  </div>
                </div>
              </li>
            </ol>
          </section>

          <section className="card" aria-labelledby="your-tokens">
            <div className="section-head">
              <h2 id="your-tokens">{tx('page.agents.yourTokens')}</h2>
              <span className="note">{tx('page.agents.eachActsAsYouNever')}</span>
            </div>
            <Said text={said?.text} tone={said?.bad ? 'bad' : undefined} />
            {tokens.isLoading ? <Loading what={t('page.agents.yourTokens2')} /> : null}
            {tokens.error ? <ErrorNote error={tokens.error} /> : null}
            {tokens.data && !tokens.data.length ? <p className="note">{tx('page.agents.youHaveNoTokensYet')}</p> : null}
            {tokens.data?.length ? (
              <Scroll label={tx('page.agents.tableOfYourTokens')}>
                <table className="figures middle">
                  <thead>
                    <tr>
                      <th scope="col">{tx('page.agents.name')}</th>
                      <th scope="col">{tx('page.agents.may')}</th>
                      <th scope="col">{tx('page.agents.where')}</th>
                      <th scope="col">{tx('page.agents.lastUsed')}</th>
                      <th scope="col">{tx('page.agents.created')}</th>
                      <th scope="col">{tx('page.agents.expires')}</th>
                      <th scope="col">
                        <span className="hidden">{tx('page.agents.revoke')}</span>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {tokens.data.map((t) => (
                      <tr key={t.id}>
                        <td>
                          <strong>{t.name}</strong>
                          <span className="item-about mono">{t.prefix}…</span>
                        </td>
                        <td>
                          <span className="chips">
                            {t.scopes.map((s) => (
                              <span key={s} className="chip">
                                {s}
                              </span>
                            ))}
                          </span>
                        </td>
                        <td>
                          {t.projects === null ? (
                            tx('page.agents.everyProject')
                          ) : t.projects.length ? (
                            <span className="chips">
                              {t.projects.map((k) => (
                                <span key={k} className="chip mono">
                                  {k}
                                </span>
                              ))}
                            </span>
                          ) : (
                            <span className="muted">{tx('page.agents.noProjectAnyMore')}</span>
                          )}
                        </td>
                        <td>{t.lastUsedAt ? <time dateTime={t.lastUsedAt}>{ago(t.lastUsedAt)}</time> : <span className="muted">{tx('page.agents.never')}</span>}</td>
                        <td>
                          <time dateTime={t.createdAt}>{ago(t.createdAt)}</time>
                        </td>
                        <td>{t.expiresAt ? <time dateTime={t.expiresAt}>{dateRead(t.expiresAt)}</time> : <span className="muted">{tx('page.agents.never')}</span>}</td>
                        <td className="fit">
                          <Confirm
                            small
                            label={tx('page.agents.revokeIt')}
                            title={tx('page.agents.revokeTheToken', { name: t.name })}
                            about={tx('page.agents.anythingUsingItLosesAccess')}
                            confirm={tx('page.agents.revokeIt')}
                            disabled={revoke.isPending}
                            onConfirm={() => revoke.mutate(t)}
                          />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </Scroll>
            ) : null}
          </section>

          <AllowedApps />
          {isAdmin ? <AgentAccounts /> : null}

          <section className="card" aria-labelledby="what-agents-get">
            <div className="section-head">
              <h2 id="what-agents-get">{tx('page.agents.whatAgentsGet')}</h2>
              <Hint
                label={tx('page.agents.whatDoTheColoursMean')}
                hint={tx('page.agents.greyMeansAToolOnly')}
              />
            </div>
            <p className="note section-note">{tx('page.agents.theSameToolsTheAssistant')}</p>
            {tools.isLoading ? <Loading what={t('page.agents.theTools')} /> : null}
            {tools.error ? <ErrorNote error={tools.error} /> : null}
            {tools.data ? (
              <>
                <h3>{tr('page.agents.whatTheyRead', { length: reads.length })}</h3>
                <ul className="tool-list">
                  {reads.map((t) => (
                    <ToolRow key={t.name} tool={t} />
                  ))}
                </ul>
                <h3>{tr('page.agents.whatTheyChange', { length: changes.length })}</h3>
                <ul className="tool-list">
                  {changes.map((t) => (
                    <ToolRow key={t.name} tool={t} />
                  ))}
                </ul>
              </>
            ) : null}
            <h3>{tx('page.agents.whatTheyCanReadAs')}</h3>
            <ul className="tool-list">
              {RESOURCES.map((r) => (
                <li key={r.uri}>
                  <div className="tool-head">
                    <code>{r.uri}</code>
                  </div>
                  <p>{r.about}</p>
                </li>
              ))}
            </ul>
            <h3>{tx('page.agents.readyMadePrompts')}</h3>
            <p className="note">{tx('page.agents.inClaudeCodeTheyRe')}</p>
            <ul className="tool-list">
              {PROMPTS.map((p) => (
                <li key={p.name}>
                  <div className="tool-head">
                    <code>{p.name}</code>
                    <span className="mono muted">{p.args}</span>
                  </div>
                  <p>{p.about}</p>
                </li>
              ))}
            </ul>
          </section>
        </div>

        <aside className="stack" aria-label={tx('page.agents.anAgentSFacts')}>
          <section className="agent-facts" aria-label={tx('page.agents.factsOfAnAgentOver')}>
            <h3>{tx('page.agents.agentFacts')}</h3>
            <div className="per">
              <span>{tx('page.agents.anAgentOverMcp')}</span>
              <span className="mono">{tx('page.agents.mcp')}</span>
            </div>
            <div className="rule" />
            <dl>
              <div className="pair">
                <dt>{tx('page.agents.worksFor')}</dt>
                <dd>{tx('page.agents.youWithItsToken')}</dd>
              </div>
              <div className="pair">
                <dt>{tx('page.agents.autonomy')}</dt>
                <dd>{tx('page.agents.asksFirstIfItsClient')}</dd>
              </div>
              <div className="pair">
                <dt>{tx('page.agents.reads')}</dt>
                <dd>{tx('page.agents.issuesBoardsPlansActivity')}</dd>
              </div>
              <div className="pair">
                <dt>{tx('page.agents.changes')}</dt>
                <dd>{tx('page.agents.issuesCommentsLinksWork')}</dd>
              </div>
              <div className="pair">
                <dt>{tx('page.agents.deletes')}</dt>
                <dd>{tx('page.agents.nothing')}</dd>
              </div>
              <div className="pair">
                <dt>{tx('page.agents.outsideContent')}</dt>
                <dd>{tx('page.agents.none')}</dd>
              </div>
              <div className="pair">
                <dt>{tx('page.agents.data')}</dt>
                <dd>{tx('page.agents.whatYouMaySee')}</dd>
              </div>
            </dl>
            <div className="thin" />
            <div className="per">
              <span>{tx('page.agents.limits')}</span>
              <span>{tx('page.agents.perCall')}</span>
            </div>
            <dl>
              <div className="pair">
                <dt>{tx('page.agents.issuesInACommand')}</dt>
                <dd>{tx('page.agents.n50AtMost')}</dd>
              </div>
              <div className="pair">
                <dt>{tx('page.agents.toolsThatRead')}</dt>
                <dd>{tools.data ? reads.length : '…'}</dd>
              </div>
              <div className="pair">
                <dt>{tx('page.agents.toolsThatChange')}</dt>
                <dd>{tools.data ? changes.length : '…'}</dd>
              </div>
            </dl>
            <div className="thin" />
            <p className="foot">{tx('page.agents.itChangesThingsOnlyWith')}</p>
          </section>
        </aside>
      </div>
    </>
  );
}

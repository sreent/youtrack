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

type Created = ApiToken & { token: string };
type Client = 'claude-code' | 'http' | 'desktop';

const PLACEHOLDER = 'a4a_your_token';

const SCOPES: { scope: Scope; about: string }[] = [
  { scope: 'read', about: 'Search and read issues, projects, boards and plans. A read-only token is the safe way to let an agent explore.' },
  { scope: 'write', about: 'Also create and change issues, comment, link them and log work, as you can.' },
  { scope: 'admin', about: 'Also change projects, fields, people and settings. Only for tools you trust with the whole instance.' },
];

const RESOURCES: { uri: string; about: string }[] = [
  { uri: 'a4a://guide/query-language', about: 'The search syntax, with examples.' },
  { uri: 'a4a://guide/commands', about: 'The command syntax.' },
  { uri: 'a4a://projects/{key}', about: "A project's schema: its fields, their values, and the link types." },
  { uri: 'a4a://issues/{id}', about: 'An issue, as Markdown. Its list holds the 50 most recently updated.' },
];

const PROMPTS: { name: string; args: string; about: string }[] = [
  {
    name: 'work_on_issue',
    args: 'issue_id',
    about: 'Read the issue and its links, take it and move it to In Progress, comment as it goes, link follow-ups, and resolve it with a summary.',
  },
  {
    name: 'triage_backlog',
    args: 'project',
    about: 'Review untriaged issues, propose Type, Priority, Assignee and tags, flag duplicates, and apply what you confirm.',
  },
  { name: 'report_bug', args: 'description', about: 'Look for duplicates first, then file a well-made bug: steps, expected and actual, environment.' },
  { name: 'status_report', args: 'project, since?', about: 'Progress, blockers and risks, from the activity and the counts.' },
  { name: 'release_notes', args: 'project, query?', about: 'Release notes from resolved issues, grouped by type.' },
  {
    name: 'schedule_review',
    args: 'project, baseline?',
    about: 'The critical path, people booked over their day, slipping tasks and cost against the baseline, with what to do about them.',
  },
];

function snippet(client: Client, origin: string, token: string): string {
  if (client === 'claude-code') return `claude mcp add --transport http a4a ${origin}/mcp --header "Authorization: Bearer ${token}"`;
  if (client === 'http') return JSON.stringify({ mcpServers: { a4a: { url: `${origin}/mcp`, headers: { Authorization: `Bearer ${token}` } } } }, null, 2);
  return JSON.stringify({ mcpServers: { a4a: { command: 'npx', args: ['a4a-mcp'], env: { A4A_URL: origin, A4A_TOKEN: token } } } }, null, 2);
}

const CLIENTS: { id: Client; label: string; where: string }[] = [
  { id: 'claude-code', label: 'Claude Code', where: 'Run this in a terminal, in the folder you work in.' },
  { id: 'http', label: 'Cursor and other HTTP clients', where: 'Put this in your client’s MCP settings, such as .cursor/mcp.json.' },
  {
    id: 'desktop',
    label: 'Claude Desktop',
    where: 'Put this in claude_desktop_config.json, then restart Claude Desktop. It runs the a4a-mcp bridge over stdio, with Node.js.',
  },
];

function ToolRow({ tool }: { tool: AITool }) {
  return (
    <li>
      <div className="tool-head">
        <code>{tool.name}</code>
        <strong>{tool.title}</strong>
        <Badge grammar={tool.kind}>{tool.kind}</Badge>
        {tool.destructive ? <span className="chip">can overwrite</span> : null}
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
      setSaid({ text: `The token ${t.name} is revoked. Anything using it can't reach a4a any more.` });
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
        title="Agents and tokens"
        about="Let an agent such as Claude Code work in a4a over MCP. With your token it acts for you, with no more than the token allows; with a token an administrator issues to an agent of its own, it acts as itself. Every change it makes is kept in the activity under its name."
      />
      <div className="split">
        <div className="stack">
          <section className="card" aria-labelledby="connect">
            <h2 id="connect">Connect an agent</h2>
            <SignInInstead />
            <ol className="steps">
              <li>
                <h3>Create a token for it</h3>
                <form
                  className="form"
                  onSubmit={(e) => {
                    e.preventDefault();
                    create.mutate();
                  }}
                >
                  <div className="tw:grid tw:grid-cols-[minmax(0,2fr)_minmax(0,1fr)] tw:items-start tw:gap-x-4 tw:gap-y-3 tw:max-[640px]:grid-cols-1">
                    <FormField
                      label="Name"
                      help={`Name it after the agent, in lower case: the activity shows its changes as “${name.trim() || 'claude-code'} for ${me.data?.name ?? 'you'}”.`}
                    >
                      {(id, help) => <input id={id} value={name} onChange={(e) => setName(e.target.value)} required maxLength={80} aria-describedby={help} />}
                    </FormField>
                    <FormField label="Expires">
                      {(id) => (
                        <select id={id} value={expires} onChange={(e) => setExpires(e.target.value)}>
                          <option value="30">In 30 days</option>
                          <option value="90">In 90 days</option>
                          <option value="365">In a year</option>
                          <option value="never">Never</option>
                        </select>
                      )}
                    </FormField>
                  </div>
                  <fieldset className="choice-group column">
                    <legend>What it may do</legend>
                    {SCOPES.map((s) => {
                      const barred = s.scope === 'admin' && !isAdmin;
                      return (
                        <label key={s.scope} className="choice">
                          <input type="checkbox" checked={scopes.has(s.scope)} onChange={() => toggle(s.scope)} disabled={barred} />
                          <span>
                            <span className="mono">{s.scope}</span>
                            <small className="field-help">{barred ? 'Your role can’t give it: a token never does more than you may.' : s.about}</small>
                          </span>
                        </label>
                      );
                    })}
                  </fieldset>
                  <fieldset className="choice-group column">
                    <legend>Where it may</legend>
                    <label className="choice">
                      <input type="radio" name="token-reach" checked={reach === 'all'} onChange={() => setReach('all')} />
                      <span>
                        Every project you can see
                        <small className="field-help">Including projects you join later.</small>
                      </span>
                    </label>
                    <label className="choice">
                      <input type="radio" name="token-reach" checked={reach === 'some'} onChange={() => setReach('some')} />
                      <span>
                        Only some projects
                        <small className="field-help">There it may do what you may; the others it can't see at all. It can't administer.</small>
                      </span>
                    </label>
                  </fieldset>
                  {reach === 'some' ? (
                    <fieldset className="choice-group columns">
                      <legend>Its projects</legend>
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
                      {create.isPending ? 'Creating…' : 'Create the token'}
                    </button>
                    {!scopes.size ? <span className="note">Choose at least one thing it may do.</span> : null}
                    {noProjects ? <span className="note">Choose at least one project.</span> : null}
                    {limitedAdmin ? <span className="note">A token limited to projects can't have admin: leave out admin, or the limit.</span> : null}
                  </div>
                  {create.error ? <ErrorNote error={create.error} /> : null}
                </form>
                {created ? (
                  <div className="secret" role="status">
                    <p>
                      <strong>Copy it now.</strong> This is the only time a4a shows the token {created.name}: it keeps only a fingerprint of it.
                    </p>
                    <code>{created.token}</code>
                    <div className="cluster">
                      <CopyButton text={created.token} label="Copy the token" what="the token" />
                      <button type="button" className="link" onClick={() => setCreated(null)}>
                        I've kept it
                      </button>
                    </div>
                  </div>
                ) : null}
              </li>
              <li>
                <h3>Add a4a to the agent</h3>
                <div className="modes" role="group" aria-label="Which agent">
                  {CLIENTS.map((c) => (
                    <button key={c.id} type="button" aria-pressed={client === c.id} onClick={() => setClient(c.id)}>
                      {c.label}
                    </button>
                  ))}
                </div>
                <p className="note">{current.where}</p>
                <div className="stack tight">
                  <pre className="snippet" aria-label={`For ${current.label}`}>
                    {snippet(client, origin, token)}
                  </pre>
                  <div className="cluster">
                    <CopyButton text={snippet(client, origin, token)} label="Copy it" what={`the setup for ${current.label}`} />
                    <span className="note">
                      {created ? `It has the token ${created.name} in it.` : `Create a token above and it goes in place of ${PLACEHOLDER}.`}
                    </span>
                  </div>
                </div>
              </li>
            </ol>
          </section>

          <section className="card" aria-labelledby="your-tokens">
            <div className="section-head">
              <h2 id="your-tokens">Your tokens</h2>
              <span className="note">Each acts as you, never beyond your role.</span>
            </div>
            <Said text={said?.text} tone={said?.bad ? 'bad' : undefined} />
            {tokens.isLoading ? <Loading what="your tokens" /> : null}
            {tokens.error ? <ErrorNote error={tokens.error} /> : null}
            {tokens.data && !tokens.data.length ? <p className="note">You have no tokens yet. Create one above for each agent or script.</p> : null}
            {tokens.data?.length ? (
              <Scroll label="Table of your tokens">
                <table className="figures middle">
                  <thead>
                    <tr>
                      <th scope="col">Name</th>
                      <th scope="col">May</th>
                      <th scope="col">Where</th>
                      <th scope="col">Last used</th>
                      <th scope="col">Created</th>
                      <th scope="col">Expires</th>
                      <th scope="col">
                        <span className="hidden">Revoke</span>
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
                            'Every project'
                          ) : t.projects.length ? (
                            <span className="chips">
                              {t.projects.map((k) => (
                                <span key={k} className="chip mono">
                                  {k}
                                </span>
                              ))}
                            </span>
                          ) : (
                            <span className="muted">No project any more</span>
                          )}
                        </td>
                        <td>{t.lastUsedAt ? <time dateTime={t.lastUsedAt}>{ago(t.lastUsedAt)}</time> : <span className="muted">Never</span>}</td>
                        <td>
                          <time dateTime={t.createdAt}>{ago(t.createdAt)}</time>
                        </td>
                        <td>{t.expiresAt ? <time dateTime={t.expiresAt}>{dateRead(t.expiresAt)}</time> : <span className="muted">Never</span>}</td>
                        <td className="fit">
                          <Confirm
                            small
                            label="Revoke it"
                            title={`Revoke the token ${t.name}?`}
                            about="Anything using it loses access at once, and nobody can bring it back. You can create another."
                            confirm="Revoke it"
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
              <h2 id="what-agents-get">What agents get</h2>
              <Hint
                label="What do the colours mean?"
                hint="Grey means a tool only reads. Coral means it changes a record, so a client can ask you before it runs."
              />
            </div>
            <p className="note section-note">
              The same tools the assistant uses, task-shaped and named for people: they take ids such as BACK-12 and values by name. None of them deletes, and a
              command stops at 50 issues and can be previewed first.
            </p>
            {tools.isLoading ? <Loading what="the tools" /> : null}
            {tools.error ? <ErrorNote error={tools.error} /> : null}
            {tools.data ? (
              <>
                <h3>What they read ({reads.length})</h3>
                <ul className="tool-list">
                  {reads.map((t) => (
                    <ToolRow key={t.name} tool={t} />
                  ))}
                </ul>
                <h3>What they change ({changes.length})</h3>
                <ul className="tool-list">
                  {changes.map((t) => (
                    <ToolRow key={t.name} tool={t} />
                  ))}
                </ul>
              </>
            ) : null}
            <h3>What they can read as context</h3>
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
            <h3>Ready-made prompts</h3>
            <p className="note">In Claude Code they're slash commands, such as /mcp__a4a__work_on_issue BACK-12.</p>
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

        <aside className="stack" aria-label="An agent's facts">
          <section className="agent-facts" aria-label="Facts of an agent over MCP">
            <h3>Agent facts</h3>
            <div className="per">
              <span>An agent over MCP</span>
              <span className="mono">/mcp</span>
            </div>
            <div className="rule" />
            <dl>
              <div className="pair">
                <dt>Works for</dt>
                <dd>you, with its token</dd>
              </div>
              <div className="pair">
                <dt>Autonomy</dt>
                <dd>asks first, if its client does</dd>
              </div>
              <div className="pair">
                <dt>Reads</dt>
                <dd>issues, boards, plans, activity</dd>
              </div>
              <div className="pair">
                <dt>Changes</dt>
                <dd>issues, comments, links, work</dd>
              </div>
              <div className="pair">
                <dt>Deletes</dt>
                <dd>nothing</dd>
              </div>
              <div className="pair">
                <dt>Outside content</dt>
                <dd>none</dd>
              </div>
              <div className="pair">
                <dt>Data</dt>
                <dd>what you may see</dd>
              </div>
            </dl>
            <div className="thin" />
            <div className="per">
              <span>Limits</span>
              <span>per call</span>
            </div>
            <dl>
              <div className="pair">
                <dt>Issues in a command</dt>
                <dd>50 at most</dd>
              </div>
              <div className="pair">
                <dt>Tools that read</dt>
                <dd>{tools.data ? reads.length : '…'}</dd>
              </div>
              <div className="pair">
                <dt>Tools that change</dt>
                <dd>{tools.data ? changes.length : '…'}</dd>
              </div>
            </dl>
            <div className="thin" />
            <p className="foot">
              It changes things only with a write token. Every change is kept in the activity as yours, with the token's name; revoke the token and it stops at
              once.
            </p>
          </section>
        </aside>
      </div>
    </>
  );
}

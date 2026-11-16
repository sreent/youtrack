import type { AgentAccount, ApiToken, Scope, User } from '@a4a/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { del, get, post } from '../../api/client';
import { keys, useProjects } from '../../api/queries';
import { ago, Badge } from '../../components/Badges';
import { ErrorNote, Loading } from '../../components/States';
import { Who } from '../../components/Who';
import { errorText, FormField, Said, Scroll } from '../common/bits';
import { Confirm } from '../common/Confirm';
import { CopyButton } from '../common/CopyButton';
import { dateRead } from '../common/format';

export const agentKeys = { all: ['agents'] as const };
const useAgents = () => useQuery({ queryKey: agentKeys.all, queryFn: () => get<AgentAccount[]>('/agents') });

type Issued = ApiToken & { token: string };

const SCOPE_WORDS: Record<Scope, string> = {
  read: 'Search and read what it can see.',
  write: 'Also take issues, change them, comment, link them and log work, as itself.',
  admin: 'Also administer. Only an agent with the administrator role can have it.',
};

/** A token for one agent: what it may do, where, and for how long. Its secret is shown once, by the caller. */
function IssueToken({ agent, onIssued }: { agent: User; onIssued: (t: Issued) => void }) {
  const projects = useProjects();
  const [name, setName] = useState('');
  const [scopes, setScopes] = useState<Set<Scope>>(() => new Set<Scope>(['read', 'write']));
  const [reach, setReach] = useState<'all' | 'some'>('all');
  const [only, setOnly] = useState<Set<string>>(() => new Set());
  const [expires, setExpires] = useState('90');
  const offered: Scope[] = agent.role === 'admin' ? ['read', 'write', 'admin'] : agent.role === 'member' ? ['read', 'write'] : ['read'];
  const issue = useMutation({
    mutationFn: () =>
      post<Issued>(`/users/${agent.id}/tokens`, {
        name: name.trim(),
        scopes: offered.filter((s) => scopes.has(s)),
        expiresInDays: expires === 'never' ? null : Number(expires),
        ...(reach === 'some' ? { projects: [...only] } : {}),
      }),
    onSuccess: (t) => {
      setName('');
      onIssued(t);
    },
  });
  const flip = <T,>(set: React.Dispatch<React.SetStateAction<Set<T>>>, v: T) =>
    set((cur) => {
      const next = new Set(cur);
      if (next.has(v)) next.delete(v);
      else next.add(v);
      return next;
    });
  const chosen = offered.filter((s) => scopes.has(s));
  const noProjects = reach === 'some' && !only.size;
  return (
    <form
      className="form"
      aria-label={`A token for ${agent.login}`}
      onSubmit={(e) => {
        e.preventDefault();
        issue.mutate();
      }}
    >
      <div className="tw:grid tw:grid-cols-[minmax(0,2fr)_minmax(0,1fr)] tw:items-start tw:gap-x-4 tw:gap-y-3 tw:max-[640px]:grid-cols-1">
        <FormField label="Its name" help={`Where it runs, such as “ci” or “laptop”: the ledger names it beside ${agent.login}'s changes.`}>
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
        {offered.map((s) => (
          <label key={s} className="choice">
            <input type="checkbox" checked={scopes.has(s)} onChange={() => flip(setScopes, s)} />
            <span>
              <span className="mono">{s}</span>
              <small className="field-help">{SCOPE_WORDS[s]}</small>
            </span>
          </label>
        ))}
      </fieldset>
      <fieldset className="choice-group column">
        <legend>Where it may</legend>
        <label className="choice">
          <input type="radio" name={`reach-${agent.id}`} checked={reach === 'all'} onChange={() => setReach('all')} />
          <span>
            Every project {agent.login} can see
            <small className="field-help">Open projects, and members-only ones it is one of the people of.</small>
          </span>
        </label>
        <label className="choice">
          <input type="radio" name={`reach-${agent.id}`} checked={reach === 'some'} onChange={() => setReach('some')} />
          <span>
            Only some projects
            <small className="field-help">Each must be one it can see. It can't administer then.</small>
          </span>
        </label>
      </fieldset>
      {reach === 'some' ? (
        <fieldset className="choice-group columns">
          <legend>Its projects</legend>
          {(projects.data ?? []).map((p) => (
            <label key={p.id} className="choice">
              <input type="checkbox" checked={only.has(p.key)} onChange={() => flip(setOnly, p.key)} />
              <span>
                <span className="mono">{p.key}</span> {p.name}
              </span>
            </label>
          ))}
        </fieldset>
      ) : null}
      <div className="cluster">
        <button type="submit" className="primary" disabled={issue.isPending || !chosen.length || !name.trim() || noProjects}>
          {issue.isPending ? 'Issuing…' : `Issue a token to ${agent.login}`}
        </button>
        {!chosen.length ? <span className="note">Choose at least one thing it may do.</span> : null}
        {noProjects ? <span className="note">Choose at least one project.</span> : null}
      </div>
      {issue.error ? <ErrorNote error={issue.error} /> : null}
    </form>
  );
}

/** One agent: who it is, its tokens, and a new one. */
function AgentCard({ account, origin }: { account: AgentAccount; origin: string }) {
  const qc = useQueryClient();
  const { agent, tokens } = account;
  const [open, setOpen] = useState(!tokens.length);
  const [issued, setIssued] = useState<Issued | null>(null);
  const [said, setSaid] = useState<{ text: string; bad?: boolean } | null>(null);
  const revoke = useMutation({
    mutationFn: (t: ApiToken) => del(`/users/${agent.id}/tokens/${t.id}`),
    onSuccess: (_, t) => {
      if (issued?.id === t.id) setIssued(null);
      setSaid({ text: `The token ${t.name} is revoked: whatever used it can't act as ${agent.login} any more.` });
      void qc.invalidateQueries({ queryKey: agentKeys.all });
    },
    onError: (e) => setSaid({ text: errorText(e), bad: true }),
  });
  const command = issued ? `claude mcp add --transport http a4a ${origin}/mcp --header "Authorization: Bearer ${issued.token}"` : '';
  return (
    <li className="card hook">
      <div className="hook-head">
        <div className="hook-what">
          <Who kind="agent" name={agent.login} about={agent.name !== agent.login ? agent.name : undefined} />
          <span className="item-about">
            A {agent.role} · added {ago(agent.createdAt)} · {tokens.length === 1 ? '1 token' : `${tokens.length} tokens`}
          </span>
        </div>
        {agent.banned ? <Badge tone="bad">banned</Badge> : <Badge tone="good">acts as itself</Badge>}
      </div>
      {tokens.length ? (
        <Scroll label={`Tokens of ${agent.login}`}>
          <table className="figures middle">
            <thead>
              <tr>
                <th scope="col">Name</th>
                <th scope="col">May</th>
                <th scope="col">Where</th>
                <th scope="col">Last used</th>
                <th scope="col">Expires</th>
                <th scope="col">
                  <span className="hidden">Revoke</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {tokens.map((t) => (
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
                  <td>{t.projects === null ? 'Every project it sees' : t.projects.length ? t.projects.join(', ') : <span className="muted">No project any more</span>}</td>
                  <td>{t.lastUsedAt ? <time dateTime={t.lastUsedAt}>{ago(t.lastUsedAt)}</time> : <span className="muted">Never</span>}</td>
                  <td>{t.expiresAt ? <time dateTime={t.expiresAt}>{dateRead(t.expiresAt)}</time> : <span className="muted">Never</span>}</td>
                  <td className="fit">
                    <Confirm
                      small
                      label="Revoke it"
                      title={`Revoke ${agent.login}'s token ${t.name}?`}
                      about={`Whatever uses it stops acting as ${agent.login} at once. You can issue another.`}
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
      ) : (
        <p className="note">No tokens yet: nothing acts as {agent.login} until you issue one.</p>
      )}
      <Said text={said?.text} tone={said?.bad ? 'bad' : undefined} />
      {issued ? (
        <div className="secret" role="status">
          <p>
            <strong>Copy it now.</strong> This is the only time a4a shows the token {issued.name}. With it, a tool acts as {agent.login}, not as you.
          </p>
          <code>{issued.token}</code>
          <p className="note">In Claude Code, for example:</p>
          <pre className="snippet" aria-label="Adding a4a to Claude Code with it">
            {command}
          </pre>
          <div className="cluster">
            <CopyButton text={issued.token} label="Copy the token" what="the token" />
            <CopyButton text={command} label="Copy the command" what="the command" />
            <button type="button" className="link" onClick={() => setIssued(null)}>
              I've kept it
            </button>
          </div>
        </div>
      ) : null}
      {open ? (
        <IssueToken
          agent={agent}
          onIssued={(t) => {
            setIssued(t);
            setSaid(null);
            setOpen(false);
            void qc.invalidateQueries({ queryKey: agentKeys.all });
          }}
        />
      ) : agent.banned ? null : (
        <div className="cluster">
          <button type="button" onClick={() => setOpen(true)}>
            Issue a token to {agent.login}
          </button>
        </div>
      )}
    </li>
  );
}

/**
 * Agents of their own (D34), for administrators: each a bot account that acts as itself, with the
 * tokens issued to it; and a new one. People make their own tokens above; an agent's are issued here.
 */
export function AgentAccounts() {
  const qc = useQueryClient();
  const agents = useAgents();
  const [login, setLogin] = useState('');
  const [said, setSaid] = useState<{ text: string; bad?: boolean } | null>(null);
  const add = useMutation({
    mutationFn: () => post<User>('/users', { login: login.trim(), name: login.trim(), isBot: true, role: 'member' }),
    onSuccess: (u) => {
      setLogin('');
      setSaid({ text: `${u.login} is added. Issue it a token below, and it acts as itself.` });
      void qc.invalidateQueries({ queryKey: agentKeys.all });
      void qc.invalidateQueries({ queryKey: keys.users });
    },
    onError: (e) => setSaid({ text: errorText(e), bad: true }),
  });
  return (
    <section className="card" aria-labelledby="own-agents">
      <div className="section-head">
        <h2 id="own-agents">Agents of their own</h2>
        <span className="note">For administrators</span>
      </div>
      <p className="note section-note">
        An agent of its own acts as itself: its changes show under its name rather than yours, issues can be assigned to it, and with its token &ldquo;me&rdquo;
        is the agent. Its tokens are issued here, never by the agent. What it changes on its own, anyone who may change the issue can undo.
      </p>
      <form
        className="form"
        onSubmit={(e) => {
          e.preventDefault();
          add.mutate();
        }}
      >
        <div className="cluster">
          <FormField label="Add an agent" help="Its login, in lower case, such as claude: the history shows it by this name.">
            {(id, help) => (
              <input id={id} value={login} onChange={(e) => setLogin(e.target.value)} pattern="[a-zA-Z0-9._\-]+" required maxLength={40} aria-describedby={help} />
            )}
          </FormField>
          <button type="submit" disabled={add.isPending || !login.trim()}>
            {add.isPending ? 'Adding…' : 'Add it'}
          </button>
        </div>
        <Said text={said?.text} tone={said?.bad ? 'bad' : undefined} />
      </form>
      {agents.isLoading ? <Loading what="the agents" /> : null}
      {agents.error ? <ErrorNote error={agents.error} /> : null}
      {agents.data && !agents.data.length ? <p className="note">No agents of their own yet.</p> : null}
      {agents.data?.length ? (
        <ul className="hooks">
          {agents.data.map((a) => (
            <AgentCard key={a.agent.id} account={a} origin={window.location.origin} />
          ))}
        </ul>
      ) : null}
    </section>
  );
}

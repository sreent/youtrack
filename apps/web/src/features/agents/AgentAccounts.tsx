import type { AgentAccount, ApiToken, Scope, User } from '@a4a/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { del, get, post } from '../../api/client';
import { keys, useProjects } from '../../api/queries';
import { ago, agoSaid, Badge } from '../../components/Badges';
import { ErrorNote, Loading } from '../../components/States';
import { Who } from '../../components/Who';
import { errorText, FormField, Said, Scroll } from '../common/bits';
import { Confirm } from '../common/Confirm';
import { CopyButton } from '../common/CopyButton';
import { dateRead } from '../common/format';
import { t, t as tx, tr } from '../../i18n';
import type { ReactNode } from 'react';

export const agentKeys = { all: ['agents'] as const };
const useAgents = () => useQuery({ queryKey: agentKeys.all, queryFn: () => get<AgentAccount[]>('/agents') });

type Issued = ApiToken & { token: string };

const SCOPE_WORDS: Record<Scope, string> = {
  read: t('agents.agentAccounts.searchAndReadWhatIt'),
  write: t('agents.agentAccounts.alsoTakeIssuesChangeThem'),
  admin: t('agents.agentAccounts.alsoAdministerOnlyAnAgent'),
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
      aria-label={tx('agents.agentAccounts.aTokenFor', { login: agent.login })}
      onSubmit={(e) => {
        e.preventDefault();
        issue.mutate();
      }}
    >
      <div className="tw:grid tw:grid-cols-[minmax(0,2fr)_minmax(0,1fr)] tw:items-start tw:gap-x-4 tw:gap-y-3 tw:max-[640px]:grid-cols-1">
        <FormField label={tx('agents.agentAccounts.itsName')} help={tx('agents.agentAccounts.whereItRunsSuchAs', { login: agent.login })}>
          {(id, help) => <input id={id} value={name} onChange={(e) => setName(e.target.value)} required maxLength={80} aria-describedby={help} />}
        </FormField>
        <FormField label={tx('agents.agentAccounts.expires')}>
          {(id) => (
            <select id={id} value={expires} onChange={(e) => setExpires(e.target.value)}>
              <option value="30">{tx('agents.agentAccounts.in30Days')}</option>
              <option value="90">{tx('agents.agentAccounts.in90Days')}</option>
              <option value="365">{tx('agents.agentAccounts.inAYear')}</option>
              <option value="never">{tx('agents.agentAccounts.never')}</option>
            </select>
          )}
        </FormField>
      </div>
      <fieldset className="choice-group column">
        <legend>{tx('agents.agentAccounts.whatItMayDo')}</legend>
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
        <legend>{tx('agents.agentAccounts.whereItMay')}</legend>
        <label className="choice">
          <input type="radio" name={`reach-${agent.id}`} checked={reach === 'all'} onChange={() => setReach('all')} />
          <span>{tr('agents.agentAccounts.everyProjectCanSeeOpen', { login: agent.login, t0: (c: ReactNode) => <small className="field-help">{c}</small> })}</span>
        </label>
        <label className="choice">
          <input type="radio" name={`reach-${agent.id}`} checked={reach === 'some'} onChange={() => setReach('some')} />
          <span>{tr('agents.agentAccounts.onlySomeProjectsEachMust', { t0: (c: ReactNode) => <small className="field-help">{c}</small> })}</span>
        </label>
      </fieldset>
      {reach === 'some' ? (
        <fieldset className="choice-group columns">
          <legend>{tx('agents.agentAccounts.itsProjects')}</legend>
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
          {issue.isPending ? tx('agents.agentAccounts.issuing') : tx('agents.agentAccounts.issueATokenTo', { login: agent.login })}
        </button>
        {!chosen.length ? <span className="note">{tx('agents.agentAccounts.chooseAtLeastOneThing')}</span> : null}
        {noProjects ? <span className="note">{tx('agents.agentAccounts.chooseAtLeastOneProject')}</span> : null}
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
      setSaid({ text: tx('agents.agentAccounts.theTokenIsRevokedWhatever', { name: t.name, login: agent.login }) });
      void qc.invalidateQueries({ queryKey: agentKeys.all });
    },
    onError: (e) => setSaid({ text: errorText(e), bad: true }),
  });
  // not words: a command to paste
  const command = issued ? `claude mcp add --transport http a4a ${origin}/mcp --header "Authorization: Bearer ${issued.token}"` : '';
  return (
    <li className="card hook">
      <div className="hook-head">
        <div className="hook-what">
          <Who kind="agent" name={agent.login} about={agent.name !== agent.login ? agent.name : undefined} />
          <span className="item-about">{tr('agents.agentAccounts.roleAdded', { role: agent.role /* a stable code the message selects on */, when: agoSaid(agent.createdAt), v: tokens.length === 1 ? tx('agents.agentAccounts.n1Token') : tx('agents.agentAccounts.tokens', { length: tokens.length }) })}</span>
        </div>
        {agent.banned ? <Badge tone="bad">{tx('agents.agentAccounts.banned')}</Badge> : <Badge tone="good">{tx('agents.agentAccounts.actsAsItself')}</Badge>}
      </div>
      {tokens.length ? (
        <Scroll label={tx('agents.agentAccounts.tokensOf', { login: agent.login })}>
          <table className="figures middle">
            <thead>
              <tr>
                <th scope="col">{tx('agents.agentAccounts.name')}</th>
                <th scope="col">{tx('agents.agentAccounts.may')}</th>
                <th scope="col">{tx('agents.agentAccounts.where')}</th>
                <th scope="col">{tx('agents.agentAccounts.lastUsed')}</th>
                <th scope="col">{tx('agents.agentAccounts.expires')}</th>
                <th scope="col">
                  <span className="hidden">{tx('agents.agentAccounts.revoke')}</span>
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
                  <td>{t.projects === null ? tx('agents.agentAccounts.everyProjectItSees') : t.projects.length ? t.projects.join(', ') : <span className="muted">{tx('agents.agentAccounts.noProjectAnyMore')}</span>}</td>
                  <td>{t.lastUsedAt ? <time dateTime={t.lastUsedAt}>{ago(t.lastUsedAt)}</time> : <span className="muted">{tx('agents.agentAccounts.neverUsed')}</span>}</td>
                  <td>{t.expiresAt ? <time dateTime={t.expiresAt}>{dateRead(t.expiresAt)}</time> : <span className="muted">{tx('agents.agentAccounts.neverExpires')}</span>}</td>
                  <td className="fit">
                    <Confirm
                      small
                      label={tx('agents.agentAccounts.revokeIt')}
                      title={tx('agents.agentAccounts.revokeSToken', { login: agent.login, name: t.name })}
                      about={tx('agents.agentAccounts.whateverUsesItStopsActing', { login: agent.login })}
                      confirm={tx('agents.agentAccounts.revokeIt')}
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
        <p className="note">{tr('agents.agentAccounts.noTokensYetNothingActs', { login: agent.login })}</p>
      )}
      <Said text={said?.text} tone={said?.bad ? 'bad' : undefined} />
      {issued ? (
        <div className="secret" role="status">
          <p>{tr('agents.agentAccounts.copyItNowThisIs', { t0: (c: ReactNode) => <strong>{c}</strong>, name: issued.name, login: agent.login })}</p>
          <code>{issued.token}</code>
          <p className="note">{tx('agents.agentAccounts.inClaudeCodeForExample')}</p>
          <pre className="snippet" aria-label={tx('agents.agentAccounts.addingA4aToClaudeCode')}>
            {command}
          </pre>
          <div className="cluster">
            <CopyButton text={issued.token} label={tx('agents.agentAccounts.copyTheToken')} what={t('agents.agentAccounts.theToken')} />
            <CopyButton text={command} label={tx('agents.agentAccounts.copyTheCommand')} what={t('agents.agentAccounts.theCommand')} />
            <button type="button" className="link" onClick={() => setIssued(null)}>{tx('agents.agentAccounts.iVeKeptIt')}</button>
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
          <button type="button" onClick={() => setOpen(true)}>{tr('agents.agentAccounts.issueATokenTo', { login: agent.login })}</button>
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
      setSaid({ text: tx('agents.agentAccounts.isAddedIssueItA', { login: u.login }) });
      void qc.invalidateQueries({ queryKey: agentKeys.all });
      void qc.invalidateQueries({ queryKey: keys.users });
    },
    onError: (e) => setSaid({ text: errorText(e), bad: true }),
  });
  return (
    <section className="card" aria-labelledby="own-agents">
      <div className="section-head">
        <h2 id="own-agents">{tx('agents.agentAccounts.agentsOfTheirOwn')}</h2>
        <span className="note">{tx('agents.agentAccounts.forAdministrators')}</span>
      </div>
      <p className="note section-note">{tx('agents.agentAccounts.anAgentOfItsOwn')}</p>
      <form
        className="form"
        onSubmit={(e) => {
          e.preventDefault();
          add.mutate();
        }}
      >
        <div className="cluster">
          <FormField label={tx('agents.agentAccounts.addAnAgent')} help={tx('agents.agentAccounts.itsLoginInLowerCase')}>
            {(id, help) => (
              <input id={id} value={login} onChange={(e) => setLogin(e.target.value)} pattern="[a-zA-Z0-9._\-]+" required maxLength={40} aria-describedby={help} />
            )}
          </FormField>
          <button type="submit" disabled={add.isPending || !login.trim()}>
            {add.isPending ? tx('agents.agentAccounts.adding') : tx('agents.agentAccounts.addIt')}
          </button>
        </div>
        <Said text={said?.text} tone={said?.bad ? 'bad' : undefined} />
      </form>
      {agents.isLoading ? <Loading what="loadingLine.agents" /> : null}
      {agents.error ? <ErrorNote error={agents.error} /> : null}
      {agents.data && !agents.data.length ? <p className="note">{tx('agents.agentAccounts.noAgentsOfTheirOwn')}</p> : null}
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

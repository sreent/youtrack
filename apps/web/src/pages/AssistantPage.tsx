import type { Conversation, ConversationDetail } from '@a4a/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { Link, NavLink, useLocation, useNavigate, useParams, useSearchParams } from 'react-router';
import { del, post } from '../api/client';
import { keys, useAIStatus, useConversation, useConversations, useFields, useMe } from '../api/queries';
import { ago, Badge } from '../components/Badges';
import { ErrorNote, Loading, PageHead } from '../components/States';
import { runTurn, useLiveTurn, useRunningIds, type Approval } from '../features/assistant/live';
import { Talk } from '../features/assistant/Talk';
import { errorText, Said } from '../features/common/bits';
import { Confirm } from '../features/common/Confirm';
import { LadderChoice, type Rung } from '../features/common/Ladder';
import { useToolMap } from '../features/common/queries';
import '../features/common/pages.css';

const RUNGS: Rung<'ask' | 'auto'>[] = [
  { value: 'ask', name: 'Asks', lvl: 'ask', about: 'Each change waits for your yes, with exactly what it would do.' },
  { value: 'auto', name: 'Acts', lvl: 'auto', about: 'Changes what you ask on its own, and says so at once.' },
];

/** The in-app agent, "assistant": your conversations beside the one you're in. */
export default function AssistantPage() {
  const { id } = useParams();
  const [search] = useSearchParams();
  const location = useLocation();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const me = useMe();
  const status = useAIStatus();
  const list = useConversations();
  const detail = useConversation(id);
  const tools = useToolMap();
  const fields = useFields();
  const live = useLiveTurn(id);
  const running = useRunningIds();
  const [mode, setMode] = useState<'ask' | 'auto'>('ask');
  const [decisions, setDecisions] = useState<Record<string, boolean>>({});
  const [said, setSaid] = useState<{ text: string; bad?: boolean } | null>(null);

  useEffect(() => setDecisions({}), [id]);

  const issue = search.get('issue')?.toUpperCase() || undefined;
  const project = (search.get('project') || issue?.split('-')[0] || '').toUpperCase() || undefined;
  const aiOn = Boolean(status.data?.enabled);
  const keep = location.search;

  const send = async (text: string): Promise<boolean> => {
    setSaid(null);
    let conversationId = id;
    if (!conversationId) {
      try {
        const conv = await post<Conversation>('/ai/conversations', project ? { project } : {});
        qc.setQueryData<ConversationDetail>(keys.conversation(conv.id), { ...conv, messages: [], pendingApprovals: [] });
        void qc.invalidateQueries({ queryKey: keys.conversations });
        conversationId = conv.id;
        navigate(`/assistant/${conv.id}${keep}`);
      } catch (e) {
        setSaid({ text: `It couldn't start a conversation: ${errorText(e)}`, bad: true });
        return false;
      }
    }
    const stored = qc.getQueryData<ConversationDetail>(keys.conversation(conversationId));
    void runTurn(qc, {
      conversationId,
      base: stored?.messages.length ?? 0,
      said: text,
      auto: mode === 'auto',
      path: 'messages',
      body: { text, ...(issue || project ? { context: { issue, project } } : {}), approvalMode: mode },
    });
    return true;
  };

  const decide = (a: Approval, approve: boolean) => {
    if (!id) return;
    const waiting = (live?.approvals.length ? live.approvals : detail.data?.pendingApprovals) ?? [];
    const next = { ...decisions, [a.toolUseId]: approve };
    setDecisions(next);
    if (!waiting.every((w) => next[w.toolUseId] !== undefined)) return;
    const chosen = Object.fromEntries(waiting.map((w) => [w.toolUseId, next[w.toolUseId]!]));
    void runTurn(qc, {
      conversationId: id,
      base: detail.data?.messages.length ?? 0,
      auto: mode === 'auto',
      path: 'approve',
      body: { decisions: waiting.map((w) => ({ toolUseId: w.toolUseId, approve: chosen[w.toolUseId] })) },
      decisions: chosen,
    });
  };

  const remove = useMutation({
    mutationFn: (cid: string) => del(`/ai/conversations/${cid}`),
    onSuccess: (_, cid) => {
      qc.removeQueries({ queryKey: keys.conversation(cid) });
      void qc.invalidateQueries({ queryKey: keys.conversations });
      setSaid({ text: 'The conversation is gone.' });
      navigate(`/assistant${keep}`);
    },
    onError: (e) => setSaid({ text: errorText(e), bad: true }),
  });

  const current = list.data?.find((c) => c.id === id) ?? detail.data;
  const notFound = Boolean(id && detail.error);

  return (
    <>
      <PageHead
        title="Assistant"
        about="Ask about your projects in your own words. It reads what it needs, and asks before it changes anything unless you let it act."
        actions={
          <Link className="button" to={`/assistant${keep}`}>
            Start a new conversation
          </Link>
        }
      />
      {status.data && !status.data.enabled ? (
        <section className="card a4p-off">
          <h2>The assistant is off on this server</h2>
          <p className="note">
            To turn it on, set <code>ANTHROPIC_API_KEY</code> in the server's environment and restart it. Until then you can read your past
            conversations, and delete them.
          </p>
        </section>
      ) : null}
      <Said text={said?.text} tone={said?.bad ? 'bad' : undefined} />
      <div className="a4p-assistant">
        <div className="a4p-assistant-side">
          <nav className="card a4p-convos" aria-label="Your conversations">
            <h2>Your conversations</h2>
            {list.isLoading ? <Loading what="conversations" /> : null}
            {list.error ? <ErrorNote error={list.error} /> : null}
            {list.data && !list.data.length ? <p className="note">None yet. What you ask starts one.</p> : null}
            {list.data?.length ? (
              <ul className="a4p-convo-list">
                {list.data.map((c) => (
                  <li key={c.id}>
                    <NavLink to={`/assistant/${c.id}${keep}`}>
                      <span className="a4p-convo-title">{c.title}</span>
                      <span className="a4p-convo-meta">
                        {c.project ? <span className="issue-id">{c.project}</span> : null}
                        <span>{ago(c.updatedAt)}</span>
                        {c.status === 'awaiting_approval' ? <Badge tone="warn">waiting on you</Badge> : null}
                        {running.has(c.id) || c.status === 'running' ? (
                          <span className="a4p-convo-run">
                            <span className="spin" aria-hidden="true" />
                            answering
                          </span>
                        ) : null}
                      </span>
                    </NavLink>
                  </li>
                ))}
              </ul>
            ) : null}
          </nav>
          <section className="card a4p-autonomy">
            <LadderChoice
              legend="When it would change something"
              rungs={RUNGS}
              value={mode}
              onChange={aiOn ? setMode : undefined}
              disabled={!aiOn}
              note="It never deletes. Each visit starts at Asks."
            />
          </section>
        </div>
        {notFound ? (
          <section className="card a4p-talk-missing">
            <h2>That conversation isn't here</h2>
            <ErrorNote error={detail.error} />
            <p className="note">
              It may have been deleted. <Link to={`/assistant${keep}`}>Start a new conversation</Link>.
            </p>
          </section>
        ) : (
          <Talk
            key={id ?? 'new'}
            forName={me.data?.name ?? 'you'}
            model={status.data?.model ?? ''}
            detail={id ? detail.data : undefined}
            loading={Boolean(id) && detail.isLoading}
            live={live}
            tools={tools}
            fieldNames={(fields.data ?? []).map((f) => f.name)}
            aiOn={aiOn}
            mode={mode}
            onAskFirst={() => setMode('ask')}
            context={{ issue, project }}
            decisions={decisions}
            onDecide={decide}
            onSend={send}
            remove={
              id && current ? (
                <Confirm
                  small
                  label="Delete"
                  title={`Delete the conversation “${current.title}”?`}
                  about="Its messages go with it, and nobody can bring them back. What it changed in your issues stays."
                  confirm="Delete it"
                  disabled={remove.isPending || running.has(id)}
                  onConfirm={() => remove.mutate(id)}
                />
              ) : null
            }
          />
        )}
      </div>
    </>
  );
}

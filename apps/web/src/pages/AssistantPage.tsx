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
import { t, tr } from '../i18n';
import type { ReactNode } from 'react';

const RUNGS: Rung<'ask' | 'auto'>[] = [
  { value: 'ask', name: t('page.assistant.asks'), lvl: 'ask', about: t('page.assistant.eachChangeWaitsForYour') },
  { value: 'auto', name: t('page.assistant.acts'), lvl: 'auto', about: t('page.assistant.changesWhatYouAskOn') },
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
        setSaid({ text: t('page.assistant.itCouldnTStartA', { errorText: errorText(e) }), bad: true });
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
    setSaid(null);
    void runTurn(qc, {
      conversationId: id,
      base: detail.data?.messages.length ?? 0,
      auto: mode === 'auto',
      path: 'approve',
      body: { decisions: waiting.map((w) => ({ toolUseId: w.toolUseId, approve: chosen[w.toolUseId] })) },
      decisions: chosen,
    }).then((r) => {
      if (r.ok) return;
      // Nothing was decided: the changes wait again, and the page says why.
      setDecisions((d) => Object.fromEntries(Object.entries(d).filter(([k]) => !(k in chosen))));
      if (r.message) setSaid({ text: t('page.assistant.yourDecisionDidnTGo', { message: r.message }), bad: true });
    });
  };

  const remove = useMutation({
    mutationFn: (cid: string) => del(`/ai/conversations/${cid}`),
    onSuccess: (_, cid) => {
      qc.removeQueries({ queryKey: keys.conversation(cid) });
      void qc.invalidateQueries({ queryKey: keys.conversations });
      setSaid({ text: t('page.assistant.theConversationIsGone') });
      navigate(`/assistant${keep}`);
    },
    onError: (e) => setSaid({ text: errorText(e), bad: true }),
  });

  const current = list.data?.find((c) => c.id === id) ?? detail.data;
  const notFound = Boolean(id && detail.error);

  return (
    <>
      <PageHead
        title={t('page.assistant.assistant')}
        about={t('page.assistant.askAboutYourProjectsIn')}
        actions={
          aiOn && id ? (
            <Link className="button" to={`/assistant${keep}`}>{t('page.assistant.startANewConversation')}</Link>
          ) : null
        }
      />
      {status.data && !status.data.enabled ? (
        <section className="card stack tight">
          <h2>{t('page.assistant.theAssistantIsOffOn')}</h2>
          <p className="note">{tr('page.assistant.whoeverRunsTheServerCan', { v: status.data.reason ? `${status.data.reason}. ` : '' })}</p>
        </section>
      ) : null}
      <Said text={said?.text} tone={said?.bad ? 'bad' : undefined} />
      <div className="tw:grid tw:grid-cols-[16rem_minmax(0,1fr)] tw:items-start tw:gap-4 tw:max-[900px]:grid-cols-1">
        <div className="stack">
          <nav className="card side-card nav-card" aria-label={t('page.assistant.yourConversations')}>
            <h2>{t('page.assistant.yourConversations')}</h2>
            {list.isLoading ? <Loading what="loadingLine.conversations" /> : null}
            {list.error ? <ErrorNote error={list.error} /> : null}
            {list.data && !list.data.length ? <p className="note">{t('page.assistant.noneYetWhatYouAsk')}</p> : null}
            {list.data?.length ? (
              <ul className="nav-list scrolls">
                {list.data.map((c) => (
                  <li key={c.id}>
                    <NavLink to={`/assistant/${c.id}${keep}`}>
                      <span className="nav-list-name">{c.title}</span>
                      <span className="nav-list-about">
                        {c.project ? <span className="issue-id">{c.project}</span> : null}
                        <span>{ago(c.updatedAt)}</span>
                        {c.status === 'awaiting_approval' ? <Badge tone="warn">{t('page.assistant.waitingOnYou')}</Badge> : null}
                        {running.has(c.id) || c.status === 'running' ? (
                          <span className="nav-list-busy">{tr('page.assistant.answering', { el: <span className="spin" aria-hidden="true" /> })}</span>
                        ) : null}
                      </span>
                    </NavLink>
                  </li>
                ))}
              </ul>
            ) : null}
          </nav>
          <section className="card side-card">
            <LadderChoice
              legend={t('page.assistant.whenItWouldChangeSomething')}
              rungs={RUNGS}
              value={mode}
              onChange={aiOn ? setMode : undefined}
              disabled={!aiOn}
              note={t('page.assistant.itNeverDeletesEachVisit')}
            />
          </section>
        </div>
        {notFound ? (
          <section className="card tw:max-[900px]:-order-1">
            <h2>{t('page.assistant.thatConversationIsnTHere')}</h2>
            <ErrorNote error={detail.error} />
            <p className="note">{tr('page.assistant.itMayHaveBeenDeleted', { t0: (c: ReactNode) => <Link to={`/assistant${keep}`}>{c}</Link> })}</p>
          </section>
        ) : (
          <Talk
            key={id ?? 'new'}
            forName={me.data?.name ?? 'you'}
            model={status.data?.model ?? ''}
            provider={status.data?.provider ?? ''}
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
                  label={t('page.assistant.delete')}
                  title={t('page.assistant.deleteTheConversation', { title: current.title })}
                  about={t('page.assistant.itsMessagesGoWithIt')}
                  confirm={t('page.assistant.deleteIt')}
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

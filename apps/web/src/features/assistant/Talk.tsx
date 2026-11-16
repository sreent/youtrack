import type { ChatMessage, ConversationDetail } from '@a4a/shared';
import { Fragment, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { Icon } from '../../components/Icon';
import { Markdown } from '../../components/Markdown';
import { Avatar } from '../../components/Who';
import { dayLabel } from '../common/format';
import type { AITool } from '../common/queries';
import { ChangeCard } from './ChangeCard';
import type { Approval, LivePart, LiveTurn } from './live';
import { stepOf, ToolRun, type RunStep } from './ToolRun';
import { t, tr } from '../../i18n';

type Row =
  | { kind: 'day'; key: string; label: string }
  | { kind: 'you'; key: string; text: string; unsent?: boolean }
  | { kind: 'agent'; key: string; text: string }
  | { kind: 'note'; key: string; text: string; live?: boolean }
  | { kind: 'run'; key: string; steps: RunStep[] }
  | { kind: 'own'; key: string; text: string }
  | { kind: 'bad'; key: string; text: string };

/** Stored messages as rows: what each said, the agent's notes, its tool calls grouped as a run. */
function storedRows(messages: ChatMessage[], live: LiveTurn | undefined): Row[] {
  const rows: Row[] = [];
  let day = '';
  const results = live?.results ?? {};
  for (const m of messages) {
    const label = dayLabel(m.createdAt);
    if (label !== day) {
      rows.push({ kind: 'day', key: `day-${m.id}`, label });
      day = label;
    }
    m.parts.forEach((part, i) => {
      const key = `${m.id}-${i}`;
      if (part.type === 'text') rows.push(m.role === 'user' ? { kind: 'you', key, text: part.text } : { kind: 'agent', key, text: part.text });
      else if (part.type === 'progress') rows.push({ kind: 'note', key, text: part.text });
      else if (part.type === 'notice') rows.push({ kind: 'own', key, text: part.text });
      else {
        const r = results[part.id];
        const step = stepOf(part, m.createdAt);
        if (r) {
          step.status = r.declined ? 'rejected' : r.ok ? 'done' : 'error';
          step.summary = r.summary;
        } else if (live?.decisions && part.id in live.decisions) {
          // Decided a moment ago: it runs now, or it won't.
          step.status = live.decisions[part.id] ? 'running' : 'rejected';
        }
        const last = rows[rows.length - 1];
        if (last?.kind === 'run') last.steps.push(step);
        else rows.push({ kind: 'run', key, steps: [step] });
      }
    });
  }
  return rows;
}

function liveRows(live: LiveTurn, hasToday: boolean): Row[] {
  const rows: Row[] = [];
  if (!hasToday) rows.push({ kind: 'day', key: 'live-day', label: t('assistant.talk.today') });
  if (live.said) rows.push({ kind: 'you', key: 'live-said', text: live.said, unsent: Boolean(live.failed) });
  live.parts.forEach((p: LivePart, i) => {
    const key = `live-${i}`;
    const lastPart = i === live.parts.length - 1;
    if (p.kind === 'text') rows.push({ kind: 'agent', key, text: p.text });
    else if (p.kind === 'progress') rows.push({ kind: 'note', key, text: p.text, live: live.running && lastPart });
    else if (p.kind === 'notice') rows.push({ kind: 'own', key, text: p.text });
    else if (p.kind === 'error') rows.push({ kind: 'bad', key, text: p.text });
    else {
      const step: RunStep = {
        id: p.id,
        name: p.name,
        status: p.status,
        summary: p.summary,
        write: p.write,
        input: p.input,
        at: p.at,
        ms: p.ms,
        onItsOwn: p.onItsOwn,
      };
      const last = rows[rows.length - 1];
      if (last?.kind === 'run') last.steps.push(step);
      else rows.push({ kind: 'run', key, steps: [step] });
    }
  });
  if (live.failed)
    rows.push({
      kind: 'bad',
      key: 'live-failed',
      text: live.failed.hint ? `${live.failed.message.replace(/[.\s]+$/, '')}. ${live.failed.hint}` : live.failed.message,
    });
  return rows;
}

/** The agent's own short notes while it works: clamped, and opened on request. */
function Note({ text, live }: { text: string; live?: boolean }) {
  const [open, setOpen] = useState(false);
  const long = text.length > 280;
  const shown = long && !open ? `${text.slice(0, 260).trimEnd()}…` : text;
  return (
    <div className="talk-note">
      {live ? <span className="spin" aria-hidden="true" /> : <Icon name="agent" />}
      <p>
        <span className="hidden">{t('assistant.talk.assistantSNote')}</span>
        {shown}
        {long ? (
          <>
            {' '}
            <button type="button" className="link" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
              {open ? t('assistant.talk.showLess') : t('assistant.talk.showAll')}
            </button>
          </>
        ) : null}
      </p>
    </div>
  );
}

export interface TalkProps {
  forName: string;
  model: string;
  /** Who serves the model: what the assistant reads goes to them. */
  provider: string;
  detail?: ConversationDetail;
  loading?: boolean;
  live?: LiveTurn;
  tools: Map<string, AITool>;
  fieldNames: string[];
  aiOn: boolean;
  mode: 'ask' | 'auto';
  onAskFirst: () => void;
  context: { issue?: string; project?: string };
  decisions: Record<string, boolean>;
  onDecide: (approval: Approval, approve: boolean) => void;
  onSend: (text: string) => Promise<boolean>;
  /** A danger button that deletes this conversation (it asks first). */
  remove?: React.ReactNode;
}

/** Ocean's Talk: the agent by its mark and name, what's said, its runs and its asks, and the composer. */
export function Talk(props: TalkProps) {
  const { detail, live, tools, aiOn, context, decisions } = props;
  const [text, setText] = useState('');
  const [facts, setFacts] = useState(false);
  const factsId = useId();
  const factsButton = useRef<HTMLButtonElement>(null);
  const body = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);

  const stored = detail?.messages ?? [];
  const shown = live ? stored.slice(0, live.base) : stored;
  const before = storedRows(shown, live);
  const after = live
    ? liveRows(
        live,
        before.some((r) => r.kind === 'day' && r.label === 'Today'),
      )
    : [];
  const rows = [...before, ...after];

  const pendingFromDetail = !live && detail ? detail.pendingApprovals : [];
  const approvals: Approval[] = live ? live.approvals : pendingFromDetail;
  // In an answer turn, the cards just decided stay in view, saying so, until the turn ends.
  const decidedCards: Approval[] = live?.decisions && detail ? detail.pendingApprovals.filter((a) => a.toolUseId in live.decisions!) : [];
  const awaiting = approvals.length > 0 && approvals.some((a) => decisions[a.toolUseId] === undefined);
  const running = Boolean(live?.running);
  const lastYou = [...rows].reverse().find((r) => r.kind === 'you') as { text: string } | undefined;

  const canSend = aiOn && !running && !awaiting && !props.loading && detail?.status !== 'running';
  const placeholder = !aiOn
    ? t('assistant.talk.theAssistantIsOffOn2')
    : running || detail?.status === 'running'
      ? t('assistant.talk.assistantIsAnswering')
      : awaiting
        ? t('assistant.talk.decideOnTheChangeAbove')
        : t('assistant.talk.askAboutYourIssuesBoards');

  // Keep the newest in view as it streams, unless the person has scrolled back to read.
  const stick = useRef(true);
  useLayoutEffect(() => {
    const el = body.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  });
  useEffect(() => {
    void document.fonts?.ready.then(() => {
      const el = body.current;
      if (el && stick.current) el.scrollTop = el.scrollHeight;
    });
  }, []);

  // A message that didn't go goes back in the box.
  useEffect(() => {
    if (live?.failed && live.said) setText((t) => t || live.said || '');
  }, [live?.failed, live?.said]);

  useEffect(() => {
    if (!facts) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setFacts(false);
        factsButton.current?.focus();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [facts]);

  const send = async (words: string) => {
    const t = words.trim();
    if (!t || !canSend) return;
    stick.current = true;
    setText('');
    const ok = await props.onSend(t);
    if (!ok) setText(t);
    input.current?.focus();
  };

  const readsCount = [...tools.values()].filter((t) => t.kind === 'reads').length;
  const changes = [...tools.values()].filter((t) => t.kind === 'changes');
  const empty = !rows.length && !approvals.length;
  const quick = context.issue
    ? [t('assistant.talk.whatIsAboutAndHow', { issue: context.issue }), t('assistant.talk.whatBlocks', { issue: context.issue }), t('assistant.talk.findIssuesLike', { issue: context.issue })]
    : [t('assistant.talk.whatChangedSinceYesterday'), t('assistant.talk.whichOpenIssuesAreCritical'), t('assistant.talk.whoHasTheMostOpen')];

  const row = (r: Row) => (
    <Fragment key={r.key}>
      {r.kind === 'day' ? <span className="talk-day">{r.label}</span> : null}
      {r.kind === 'you' ? (
        <p className={r.unsent ? 'say you unsent' : 'say you'}>
          {r.text}
          {r.unsent ? <span className="say-unsent">{t('assistant.talk.notSent')}</span> : null}
        </p>
      ) : null}
      {r.kind === 'agent' ? (
        <div className="say agent">
          <Markdown text={r.text} />
        </div>
      ) : null}
      {r.kind === 'note' ? <Note text={r.text} live={r.live} /> : null}
      {r.kind === 'run' ? <ToolRun steps={r.steps} tools={tools} onAskFirst={props.mode === 'auto' ? props.onAskFirst : undefined} /> : null}
      {r.kind === 'own' ? (
        <p className="say own">
          <Icon name="audit" />
          <span>{r.text}</span>
        </p>
      ) : null}
      {r.kind === 'bad' ? (
        <p className="say own bad" role="alert">
          <Icon name="cross" />
          <span>{r.text}</span>
        </p>
      ) : null}
    </Fragment>
  );
  const card = (a: Approval) => (
    <ChangeCard
      key={a.toolUseId}
      approval={a}
      tool={tools.get(a.name)}
      forName={props.forName}
      asked={lastYou?.text}
      decided={live?.decisions?.[a.toolUseId] ?? decisions[a.toolUseId]}
      busy={running}
      blocked={aiOn ? undefined : t('assistant.talk.theAssistantIsOffOn')}
      fieldNames={props.fieldNames}
      onDecide={(yes) => props.onDecide(a, yes)}
    />
  );

  return (
    <section
      className="talk on-page tw:h-[clamp(28rem,calc(100vh_-_12.5rem),64rem)] tw:max-[900px]:h-[75dvh] tw:max-[900px]:-order-1"
      aria-label={t('assistant.talk.aConversationWithAssistant')}
    >
      <header className="talk-head">
        <Avatar kind="agent" name="assistant" />
        <span className="talk-who">
          <strong>{t('assistant.talk.assistant')}</strong>
          <span>{tr('assistant.talk.worksOnYourIssuesBoards', { forName: props.forName })}</span>
        </span>
        <button type="button" className="link" ref={factsButton} aria-expanded={facts} aria-controls={factsId} onClick={() => setFacts((f) => !f)}>{t('assistant.talk.whatItMayDo')}</button>
        {props.remove}
      </header>
      {facts ? (
        <section className="agent-facts talk-facts" id={factsId} aria-label={t('assistant.talk.whatAssistantMayDo')}>
          <h3>{t('assistant.talk.agentFacts')}</h3>
          <div className="per">
            <span>{t('assistant.talk.assistant')}</span>
            <span className="mono">{props.model}</span>
          </div>
          <div className="rule" />
          <dl>
            <div className="pair">
              <dt>{t('assistant.talk.worksFor')}</dt>
              <dd>{tr('assistant.talk.asYou', { forName: props.forName })}</dd>
            </div>
            <div className="pair">
              <dt>{t('assistant.talk.autonomy')}</dt>
              <dd>{props.mode === 'ask' ? t('assistant.talk.asksChangesWaitForYour') : t('assistant.talk.actsChangesOnItsOwn')}</dd>
            </div>
            <div className="pair">
              <dt>{t('assistant.talk.reads')}</dt>
              <dd>{t('assistant.talk.issuesBoardsPlansActivity')}</dd>
            </div>
            <div className="pair">
              <dt>{t('assistant.talk.changes')}</dt>
              <dd>{t('assistant.talk.issuesCommentsLinksWorkBaselines')}</dd>
            </div>
            <div className="pair">
              <dt>{t('assistant.talk.deletes')}</dt>
              <dd>{t('assistant.talk.nothing')}</dd>
            </div>
            <div className="pair">
              <dt>{t('assistant.talk.outsideContent')}</dt>
              <dd>{t('assistant.talk.none')}</dd>
            </div>
            <div className="pair">
              <dt>{t('assistant.talk.data')}</dt>
              <dd>{t('assistant.talk.whatYouMaySee')}</dd>
            </div>
            {props.provider ? (
              <div className="pair">
                <dt>{t('assistant.talk.runsOn')}</dt>
                <dd>{props.provider}</dd>
              </div>
            ) : null}
          </dl>
          <div className="thin" />
          <div className="per">
            <span>{t('assistant.talk.itsTools')}</span>
            <span>{tools.size}</span>
          </div>
          <dl>
            <div className="pair">
              <dt>{t('assistant.talk.read')}</dt>
              <dd>{readsCount}</dd>
            </div>
            <div className="pair">
              <dt>{t('assistant.talk.changeARecord')}</dt>
              <dd>{tr('assistant.talk.canOverwrite', { length: changes.length, length2: changes.filter((t) => t.destructive).length })}</dd>
            </div>
          </dl>
          <div className="thin" />
          <p className="foot">{t('assistant.talk.issueTextIsDataTo')}</p>
        </section>
      ) : null}

      <div
        className="talk-body"
        ref={body}
        onScroll={(e) => {
          const el = e.currentTarget;
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
        }}
      >
        {empty ? (
          <>
            <p className="say own">
              <Icon name="audit" />
              <span>{tr('assistant.talk.assistantReadsWhatYouMay', { v: props.mode === 'ask' ? t('assistant.talk.asksBeforeItChangesAnything') : t('assistant.talk.changesWhatYouAskOn'), v2: context.issue
                  ? t('assistant.talk.itStartsFromTheIssue', { issue: context.issue })
                  : context.project
                    ? t('assistant.talk.itStartsFromProject', { project: context.project })
                    : '' })}</span>
            </p>
            {aiOn ? (
              <div className="replies">
                {quick.map((q, i) => (
                  <button key={q} type="button" className={i === 0 && !text.trim() ? 'primary' : undefined} onClick={() => void send(q)}>
                    {q}
                  </button>
                ))}
              </div>
            ) : null}
          </>
        ) : null}
        {props.loading && !rows.length ? <p className="talk-day">{t('assistant.talk.loadingTheConversation')}</p> : null}
        {before.map(row)}
        {decidedCards.map(card)}
        {after.map(row)}
        {running && (!live?.parts.length || live.parts[live.parts.length - 1]!.kind === 'tool') ? (
          <p className="talk-working" role="status">{tr('assistant.talk.assistantIsWorkingOnIt', { el: <span className="spin" aria-hidden="true" /> })}</p>
        ) : null}
        {approvals.map(card)}
        {approvals.length > 1 && awaiting ? <p className="talk-day">{t('assistant.talk.decideOnEachChangeAssistant')}</p> : null}
      </div>

      <form
        className="talk-foot"
        onSubmit={(e) => {
          e.preventDefault();
          void send(text);
        }}
      >
        <textarea
          ref={input}
          rows={1}
          aria-label={t('assistant.talk.yourMessage')}
          placeholder={placeholder}
          value={text}
          disabled={!canSend}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              void send(text);
            }
          }}
        />
        <button type="submit" className={text.trim() && canSend ? 'round primary' : 'round'} aria-label={t('assistant.talk.send')} disabled={!canSend || !text.trim()}>
          <Icon name="send" />
        </button>
      </form>
    </section>
  );
}

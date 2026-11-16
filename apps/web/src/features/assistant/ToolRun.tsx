import type { ChatPart } from '@a4a/shared';
import { Badge } from '../../components/Badges';
import { Avatar } from '../../components/Who';
import { Linked } from '../common/bits';
import { clock, excerpt, ISSUE_ID } from '../common/format';
import type { AITool } from '../common/queries';
import type { ToolStatus } from './live';
import { t, tr } from '../../i18n';

/** One tool call in a run: from a stored message, or as it streams. */
export interface RunStep {
  id: string;
  name: string;
  status: ToolStatus;
  summary: string | null;
  write: boolean;
  input?: unknown;
  /** When it ran (the step's time, to the second). */
  at?: string;
  /** How long it took, when it streamed. */
  ms?: number;
  /** Changed something without asking, because the person let it act. */
  onItsOwn?: boolean;
}

/** A stored tool part as a step. */
export function stepOf(part: Extract<ChatPart, { type: 'tool' }>, at?: string): RunStep {
  return { id: part.id, name: part.name, status: part.status, summary: part.summary, write: part.write, input: part.input, at };
}

/** What a call was about, from its input, until its result says more. */
function aboutInput(input: unknown): string {
  if (!input || typeof input !== 'object') return '';
  const o = input as Record<string, unknown>;
  const ids = Array.isArray(o.issues) ? (o.issues as unknown[]).map(String).join(', ') : '';
  if (typeof o.command === 'string') return `“${o.command}”${ids ? t('assistant.toolRun.on', { ids: ids }) : ''}`;
  if (typeof o.query === 'string' && o.query) return `“${excerpt(o.query, 80)}”`;
  if (typeof o.issue === 'string') return typeof o.other === 'string' ? `${o.issue} ${String(o.relation ?? '')} ${o.other}` : o.issue;
  if (typeof o.summary === 'string') return `“${excerpt(o.summary, 80)}”`;
  if (typeof o.text === 'string') return `“${excerpt(o.text, 60)}”`;
  if (typeof o.project === 'string') return o.project;
  if (ids) return ids;
  return '';
}

/**
 * Ocean's RunTimeline for the agent's tool calls: each step a ring in the colour of what its tool
 * does (reads, or changes a record), how it stands in words with its shape, and the time it ran.
 * What runs turns until it's done.
 */
export function ToolRun({
  steps,
  tools,
  onAskFirst,
  label = t('assistant.toolRun.whatItDid'),
}: {
  steps: RunStep[];
  tools?: Map<string, AITool>;
  /** Shown after a change it made on its own: take autonomy back. */
  onAskFirst?: () => void;
  label?: string;
}) {
  if (!steps.length) return null;
  const alone = steps.filter((s) => s.onItsOwn && s.status === 'done');
  return (
    <>
      <div className="run-card">
        <ol className="timeline" aria-label={label}>
          {steps.map((s) => {
            const tool = tools?.get(s.name);
            const kind = tool?.kind ?? (s.write ? 'changes' : 'reads');
            const tone = s.status === 'error' ? 'bad' : s.status === 'rejected' ? 'idle' : s.status === 'pending_approval' ? 'changes' : kind;
            // Declined, it did nothing: say what it would have done.
            const what = (s.status === 'rejected' ? null : s.summary) ?? (aboutInput(s.input) || tool?.title || '');
            return (
              <li key={s.id}>
                <time dateTime={s.at}>{s.at ? clock(s.at) : ''}</time>
                {s.status === 'running' ? (
                  <span className="spin" aria-hidden="true" />
                ) : (
                  <span className={`node tone-${tone}`} aria-hidden="true" />
                )}
                <span className="step-what">
                  <code>{s.name}</code> {what ? <Linked text={what} /> : null}
                  <span className="step-detail">
                    <Badge grammar={kind}>{kind}</Badge>
                    {s.status === 'running' ? <span>{kind === 'reads' ? t('assistant.toolRun.reading') : t('assistant.toolRun.changing')}</span> : null}
                    {s.status === 'pending_approval' ? <Badge tone="warn">{t('assistant.toolRun.waitingOnYou')}</Badge> : null}
                    {s.status === 'error' ? <Badge tone="bad">{t('assistant.toolRun.failed')}</Badge> : null}
                    {s.status === 'rejected' ? <Badge tone="idle">{t('assistant.toolRun.youDeclinedIt')}</Badge> : null}
                    {s.status === 'done' && s.onItsOwn ? <span>{t('assistant.toolRun.onItsOwnAsYou')}</span> : null}
                    {s.status === 'done' && s.ms !== undefined && s.ms > 0 ? (
                      <span className="step-took">{s.ms < 1000 ? t('assistant.toolRun.ms', { ms: s.ms }) : `${(s.ms / 1000).toFixed(1)} s`}</span>
                    ) : null}
                    {tool?.destructive && s.status !== 'done' ? <span className="chip">{t('assistant.toolRun.canOverwrite')}</span> : null}
                  </span>
                </span>
              </li>
            );
          })}
        </ol>
      </div>
      {alone.length ? <ActedAlone steps={alone} onAskFirst={onAskFirst} /> : null}
    </>
  );
}

/**
 * Ocean's Status for what the agent did on its own, at the ladder's top rung: what it did, in the
 * colour of what it did, at once; what allowed it; and a way to take the autonomy back.
 */
function ActedAlone({ steps, onAskFirst }: { steps: RunStep[]; onAskFirst?: () => void }) {
  const last = steps[steps.length - 1]!;
  // The issues it changed, from what each step said and what it was given.
  const ids = [...new Set(steps.flatMap((s) => `${s.summary ?? ''} ${JSON.stringify(s.input ?? '')}`.match(ISSUE_ID) ?? []))];
  return (
    <section className="draft acted" aria-label={t('assistant.toolRun.whatItDidOnIts')}>
      <div className="acted-head">
        <Avatar kind="agent" name="assistant" />
        <div>
          <strong>
            <Linked text={steps.length === 1 ? (last.summary ?? t('assistant.toolRun.madeAChange')) : t('assistant.toolRun.madeChanges', { length: steps.length })} />
          </strong>
          <p>{tr('assistant.toolRun.assistantOnItsOwn', { v: last.at ? ` · ${clock(last.at)}` : '' })}</p>
        </div>
      </div>
      <p className="commits">
        <span className="badge changes">{t('assistant.toolRun.changes')}</span>
        <span>
          {ids.length ? (
            <>{tr('assistant.toolRun.itChangedAndHistorySays', { el: <Linked text={ids.join(', ')} />, v: ids.length === 1 ? 'its' : 'their' })}</>
          ) : (
            t('assistant.toolRun.itChangedWhatYouAsked')
          )}
        </span>
      </p>
      <dl className="facts-sm">
        <dt>{t('assistant.toolRun.allowedBy')}</dt>
        <dd>{t('assistant.toolRun.youLetItActIn')}</dd>
      </dl>
      {onAskFirst ? (
        <button type="button" className="link" onClick={onAskFirst}>{t('assistant.toolRun.askMeFirstNextTime')}</button>
      ) : null}
    </section>
  );
}

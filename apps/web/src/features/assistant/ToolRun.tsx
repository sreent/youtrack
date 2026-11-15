import type { ChatPart } from '@a4a/shared';
import { Badge } from '../../components/Badges';
import { Linked } from '../common/bits';
import { clock, excerpt } from '../common/format';
import type { AITool } from '../common/queries';
import type { ToolStatus } from './live';

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
  if (typeof o.command === 'string') return `“${o.command}”${ids ? ` on ${ids}` : ''}`;
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
  label = 'What it did',
}: {
  steps: RunStep[];
  tools?: Map<string, AITool>;
  /** Shown after a change it made on its own: take autonomy back. */
  onAskFirst?: () => void;
  label?: string;
}) {
  if (!steps.length) return null;
  const actedAlone = steps.some((s) => s.onItsOwn && s.status === 'done');
  return (
    <div className="a4p-run">
      <ol className="timeline" aria-label={label}>
        {steps.map((s) => {
          const tool = tools?.get(s.name);
          const kind = tool?.kind ?? (s.write ? 'changes' : 'reads');
          const tone = s.status === 'error' ? 'bad' : s.status === 'rejected' ? 'idle' : s.status === 'pending_approval' ? 'changes' : kind;
          const what = s.summary ?? (aboutInput(s.input) || tool?.title || '');
          return (
            <li key={s.id}>
              <time dateTime={s.at}>{s.at ? clock(s.at) : ''}</time>
              {s.status === 'running' ? <span className="spin a4p-run-spin" aria-hidden="true" /> : <span className={`node tone-${tone}`} aria-hidden="true" />}
              <span className="a4p-run-what">
                <code>{s.name}</code> {what ? <Linked text={what} /> : null}
                <span className="step-detail">
                  <Badge grammar={kind}>{kind}</Badge>
                  {s.status === 'running' ? <span>{kind === 'reads' ? 'reading…' : 'changing…'}</span> : null}
                  {s.status === 'pending_approval' ? <Badge tone="warn">waiting on you</Badge> : null}
                  {s.status === 'error' ? <Badge tone="bad">failed</Badge> : null}
                  {s.status === 'rejected' ? <Badge tone="idle">you declined it</Badge> : null}
                  {s.status === 'done' && s.onItsOwn ? <span>on its own, as you let it</span> : null}
                  {s.status === 'done' && s.ms !== undefined ? <span className="a4p-ms">{s.ms < 1000 ? `${s.ms} ms` : `${(s.ms / 1000).toFixed(1)} s`}</span> : null}
                  {tool?.destructive && s.status !== 'done' ? <span className="chip">can overwrite</span> : null}
                </span>
              </span>
            </li>
          );
        })}
      </ol>
      {actedAlone && onAskFirst ? (
        <p className="a4p-run-foot">
          <span>It changed this on its own, because you let it act.</span>
          <button type="button" className="link" onClick={onAskFirst}>
            Ask me first next time
          </button>
        </p>
      ) : null}
    </div>
  );
}

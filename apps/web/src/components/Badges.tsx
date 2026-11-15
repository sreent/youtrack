import type { IssueField, OptionValue, Tone } from '@a4a/shared';
import { Link } from 'react-router';
import { Icon, type IconName } from './Icon';

const SHAPE: Record<Tone, IconName> = { good: 'check', warn: 'clock', bad: 'cross', idle: 'pause' };

type Grammar = 'reads' | 'writes' | 'changes' | 'outside' | 'own';

/** How something stands (shape + colour + word), or what a tool does (colour + word). Never colour alone. */
export function Badge({ tone, grammar, children, title }: { tone?: Tone | null; grammar?: Grammar; children: React.ReactNode; title?: string }) {
  const cls = ['badge', tone ?? grammar ?? ''].filter(Boolean).join(' ');
  return (
    <span className={cls} title={title}>
      {tone ? <Icon name={SHAPE[tone]} /> : null}
      {children}
    </span>
  );
}

export function Chip({ children, mono }: { children: React.ReactNode; mono?: boolean }) {
  return <span className={mono ? 'chip mono' : 'chip'}>{children}</span>;
}

export function fieldOf(fields: IssueField[], name: string): IssueField | undefined {
  return fields.find((f) => f.name.toLowerCase() === name.toLowerCase());
}

export function optionOf(fields: IssueField[], name: string): OptionValue | null {
  const v = fieldOf(fields, name)?.value;
  if (v && typeof v === 'object' && !Array.isArray(v) && 'ordinal' in v) return v as OptionValue;
  return null;
}

/** An issue's state: plain when open, with its tone once it means something (review, blocked, resolved). */
export function StateBadge({ fields }: { fields: IssueField[] }) {
  const state = optionOf(fields, 'State');
  if (!state) return null;
  return <Badge tone={state.tone}>{state.name}</Badge>;
}

const PRIORITY_STEPS = 5;

/** Priority as a five-step meter beside its word: shape, never colour. */
export function PriorityMeter({ fields, compact }: { fields: IssueField[]; compact?: boolean }) {
  const p = optionOf(fields, 'Priority');
  if (!p) return null;
  const filled = Math.max(1, PRIORITY_STEPS - p.ordinal);
  return (
    <span className="priority" role="img" aria-label={`Priority: ${p.name}`}>
      <span className="priority-meter" aria-hidden="true">
        {Array.from({ length: PRIORITY_STEPS }, (_, i) => (
          <span key={i} className={i < filled ? 'on' : undefined} />
        ))}
      </span>
      {compact ? null : <span className="priority-word">{p.name}</span>}
    </span>
  );
}

export function IssueLink({ id, children }: { id: string; children?: React.ReactNode }) {
  return (
    <Link className="a4-issue-id" to={`/issues/${id}`}>
      {children ?? id}
    </Link>
  );
}

export function ago(iso: string, now = Date.now()): string {
  const t = new Date(iso).getTime();
  const s = Math.round((now - t) / 1000);
  if (s < 45) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m} minute${m === 1 ? '' : 's'} ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} hour${h === 1 ? '' : 's'} ago`;
  const d = Math.round(h / 24);
  if (d < 7) return `${d} day${d === 1 ? '' : 's'} ago`;
  return new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: new Date(iso).getFullYear() === new Date().getFullYear() ? undefined : 'numeric' });
}

export function Time({ iso, exact }: { iso: string; exact?: boolean }) {
  const d = new Date(iso);
  const text = exact ? d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : ago(iso);
  return (
    <time dateTime={iso} title={d.toLocaleString()}>
      {text}
    </time>
  );
}

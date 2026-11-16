import type { IssueField, OptionValue, Tone } from '@a4a/shared';
import { Link } from 'react-router';
import { Icon, type IconName } from './Icon';
import { formatDate, formatDateTime, formatRelative, t } from '../i18n';

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

/** Five levels, highest first: Show-stopper 5 … Minor 1, from the option's place in its list. */
export function priorityLevel(p: OptionValue): number {
  return Math.max(1, Math.min(5, 5 - p.ordinal));
}

/**
 * Priority as five rising steps beside its word: a shape, never a colour (Ocean's PriorityMeter).
 * Inside a control, the meter is named "Priority" whatever it shows, so the control is named by
 * its word instead (`wordId`).
 */
export function PriorityMeter({ fields, value, wordId }: { fields?: IssueField[]; value?: OptionValue | null; wordId?: string }) {
  const p = value ?? (fields ? optionOf(fields, 'Priority') : null);
  if (!p) return null;
  const level = priorityLevel(p);
  return (
    <span className="priority" role="meter" aria-label={t('ui.badges.priority')} aria-valuemin={1} aria-valuemax={5} aria-valuenow={level} aria-valuetext={p.name}>
      <span className="priority-steps" aria-hidden="true">
        <i />
        <i />
        <i />
        <i />
        <i />
      </span>
      <span className="priority-word" id={wordId}>
        {p.name}
      </span>
    </span>
  );
}

export function IssueLink({ id, children }: { id: string; children?: React.ReactNode }) {
  return (
    <Link className="issue-id" to={`/issues/${id}`}>
      {children ?? id}
    </Link>
  );
}

/** "just now", "5 minutes ago", then the day: in the page's language (D49). */
export function ago(iso: string, now = Date.now()): string {
  const at = new Date(iso).getTime();
  const s = Math.round((now - at) / 1000);
  if (s < 45) return t('ui.badges.justNow');
  const m = Math.round(s / 60);
  if (m < 60) return formatRelative(-m, 'minute');
  const h = Math.round(m / 60);
  if (h < 24) return formatRelative(-h, 'hour');
  const d = Math.round(h / 24);
  if (d < 7) return formatRelative(-d, 'day');
  return formatDate(iso, { day: 'numeric', month: 'short', year: new Date(iso).getFullYear() === new Date().getFullYear() ? undefined : 'numeric' });
}

export function Time({ iso, exact }: { iso: string; exact?: boolean }) {
  const d = new Date(iso);
  const text = exact ? formatDateTime(d, { dateStyle: 'medium', timeStyle: 'short' }) : ago(iso);
  return (
    <time dateTime={iso} title={formatDateTime(d)}>
      {text}
    </time>
  );
}

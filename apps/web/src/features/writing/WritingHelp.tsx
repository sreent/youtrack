/**
 * Writing help in a field (docs/architecture.md, D59): a menu for the whole text in the editor's bar, a
 * toolbar for what's selected, and each answer a suggestion beside what it would replace, as a change in
 * Ocean's grammar, to accept, edit or discard. Nothing is in the text until the person accepts it, and
 * nothing is saved until they save the field, as ever. Offered only while the server has an AI provider.
 */
import type { DiffLine, TextSummary, WriteResult, WritingAction, WritingFor } from '@a4a/shared';
import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { post } from '../../api/client';
import { useAIStatus } from '../../api/queries';
import { Markdown } from '../../components/Markdown';
import { ErrorLine } from '../../components/States';
import { Avatar, Who } from '../../components/Who';
import { Diff } from '../articles/Diff';
import { errorText } from '../common/bits';
import type { Picked } from '../editor/VisualEditor';
import { t } from '../../i18n';

const EDITS = ['fix', 'shorter', 'clearer', 'formal', 'friendlier'] as const;

/** Whether the server has an AI provider: without one, no page offers writing help. */
export function useWritingOn(): boolean {
  return Boolean(useAIStatus().data?.enabled);
}

/** A text's lines against another's, the fewest added and removed (a field's text is short enough to compare whole). */
export function lineDiff(before: string, after: string): DiffLine[] {
  const a = before ? before.split('\n') : [];
  const b = after ? after.split('\n') : [];
  if (a.length * b.length > 250_000) return [...a.map((text) => ({ op: 'del' as const, text })), ...b.map((text) => ({ op: 'add' as const, text }))];
  const same = Array.from({ length: a.length + 1 }, () => new Uint32Array(b.length + 1));
  for (let i = a.length - 1; i >= 0; i--) for (let j = b.length - 1; j >= 0; j--) same[i]![j] = a[i] === b[j] ? same[i + 1]![j + 1]! + 1 : Math.max(same[i + 1]![j]!, same[i]![j + 1]!);
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      out.push({ op: 'same', text: a[i]! });
      i++;
      j++;
    } else if (same[i + 1]![j]! >= same[i]![j + 1]!) out.push({ op: 'del', text: a[i++]! });
    else out.push({ op: 'add', text: b[j++]! });
  }
  while (i < a.length) out.push({ op: 'del', text: a[i++]! });
  while (j < b.length) out.push({ op: 'add', text: b[j++]! });
  return out;
}

/**
 * What the assistant suggests, as Ocean's ApprovalCard for something written and not yet relied on: its
 * mark and name, that it's a suggestion, the text's lines it would remove and add, and Accept, Edit or
 * Discard. Edited, it's the person's words that go in.
 */
export function SuggestionCard({
  action,
  original,
  text,
  error,
  onAccept,
  onDiscard,
}: {
  action: WritingAction;
  original: string;
  text: string;
  error?: string;
  onAccept: (text: string) => void;
  onDiscard: () => void;
}) {
  const titleId = useId();
  const editId = useId();
  const card = useRef<HTMLElement>(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(text);
  const unchanged = text.trim() === original.trim();
  // Said where the person is: a screen reader hears the suggestion once it's there.
  useEffect(() => card.current?.focus(), []);
  return (
    <section className="approval compact" aria-labelledby={titleId} ref={card} tabIndex={-1}>
      <div className="approval-stripe writes" />
      <div className="approval-body">
        <div className="who">
          <Avatar kind="agent" name="assistant" small />
          <span>
            <span className="who-name" id={titleId}>
              {t('writing.suggestion.title', { action })}
            </span>
            <span className="who-about">{t('writing.suggestion.byTheAssistant')}</span>
          </span>
        </div>
        {unchanged ? (
          <p className="approval-note">{t('writing.suggestion.nothingToChange')}</p>
        ) : editing ? (
          <div className="form-field">
            <label htmlFor={editId}>{t('writing.suggestion.changeItFirst')}</label>
            <textarea id={editId} rows={Math.min(14, Math.max(4, draft.split('\n').length + 1))} value={draft} onChange={(e) => setDraft(e.target.value)} />
          </div>
        ) : (
          <>
            <p className="approval-note">{t('writing.suggestion.notInTheTextYet')}</p>
            <Diff lines={lineDiff(original, text)} label={t('writing.suggestion.whatItWouldChange')} />
          </>
        )}
        {error ? <ErrorLine>{error}</ErrorLine> : null}
        <div className="approval-actions">
          {unchanged ? null : (
            <button type="button" className="primary" onClick={() => onAccept(editing ? draft : text)}>
              {t('writing.suggestion.accept')}
            </button>
          )}
          {unchanged || editing ? null : (
            <button type="button" onClick={() => setEditing(true)}>
              {t('writing.suggestion.edit')}
            </button>
          )}
          <button type="button" onClick={onDiscard}>
            {unchanged ? t('writing.close') : t('writing.suggestion.discard')}
          </button>
        </div>
      </div>
    </section>
  );
}

/** A summary by the assistant: shown, never saved, unless what holds it offers more (`children`). */
export function SummaryCard({ label, did, summary, note, onClose, children }: { label: string; did: string; summary: string; note?: string | null; onClose: () => void; children?: ReactNode }) {
  const card = useRef<HTMLElement>(null);
  useEffect(() => card.current?.focus(), []);
  return (
    <section className="card stack" aria-label={label} ref={card} tabIndex={-1}>
      <div className="cluster">
        <Who kind="agent" name="assistant" small />
        <span className="note">{did}</span>
      </div>
      <Markdown text={summary} />
      {note ? <p className="note">{note}</p> : null}
      <div className="cluster">
        {children}
        <button type="button" onClick={onClose}>
          {t('writing.close')}
        </button>
      </div>
    </section>
  );
}

type Asked =
  | { kind: 'write'; action: WritingAction; original: string; picked: Picked; text?: string; error?: string }
  | { kind: 'summary'; summary?: TextSummary; error?: string };

/**
 * Writing help for a field: the button for its bar (and, for a reply, "Draft a reply" beside it), and
 * the panel under the field: the menu for the whole text, the toolbar for what's selected, and what the
 * assistant answered. `pick` reads the selection, `whole` the whole text, each with how to replace it.
 */
export function useWritingHelp({
  at,
  endpoint = '/ai/write',
  value,
  selected,
  pick,
  whole,
  focusField,
  say,
}: {
  at: WritingFor | undefined;
  /** Where the ask goes: the portal's own route for a requester's pages (D59's revisit). */
  endpoint?: string;
  value: string;
  selected: boolean;
  pick: () => Picked | null;
  whole: (carryOn: boolean) => Picked;
  focusField: () => void;
  say: (text: string, bad?: boolean) => void;
}): { button: ReactNode; panel: ReactNode } {
  const on = useWritingOn() && Boolean(at);
  const [open, setOpen] = useState(false);
  const [asked, setAsked] = useState<Asked | null>(null);
  const [busy, setBusy] = useState(false);
  const menuId = useId();
  if (!on || !at) return { button: null, panel: null };

  const ask = async (action: WritingAction, scope: 'selection' | 'all') => {
    const picked = scope === 'selection' ? pick() : whole(action === 'continue');
    if (!picked) return;
    const original = picked.text;
    // A selection's own spaces and line ends, around its words, stay where they were.
    const lead = scope === 'selection' ? /^\s*/.exec(original)![0] : '';
    const trail = scope === 'selection' ? /\s*$/.exec(original)![0] : '';
    setOpen(false);
    setBusy(true);
    setAsked({ kind: 'write', action, original: action === 'continue' ? '' : original, picked });
    try {
      const r = await post<WriteResult>(endpoint, { action, text: original, for: at });
      setAsked((a) => (a?.kind === 'write' && a.picked === picked ? { ...a, text: lead + r.text + trail } : a));
    } catch (e) {
      setAsked((a) => (a?.kind === 'write' && a.picked === picked ? { ...a, error: errorText(e) } : a));
    } finally {
      setBusy(false);
    }
  };

  const summarise = async () => {
    const picked = pick();
    if (!picked) return;
    setBusy(true);
    setAsked({ kind: 'summary' });
    try {
      const summary = await post<TextSummary>('/ai/summarize', { text: picked.text });
      setAsked({ kind: 'summary', summary });
    } catch (e) {
      setAsked({ kind: 'summary', error: errorText(e) });
    } finally {
      setBusy(false);
    }
  };

  const close = (said?: string) => {
    setAsked(null);
    if (said) say(said);
    focusField();
  };

  const accept = (text: string) => {
    if (asked?.kind !== 'write') return;
    if (!asked.picked.apply(text)) return setAsked({ ...asked, error: t('writing.changedSince') });
    close(t('writing.accepted'));
  };

  const keep = (e: React.MouseEvent) => e.preventDefault();
  const empty = !value.trim();
  const button = (
    <>
      {at.kind === 'reply' ? (
        <button type="button" onMouseDown={keep} onClick={() => void ask('draft', 'all')} disabled={busy}>
          <Avatar kind="agent" name="assistant" small />
          {t('writing.draft', { kind: 'reply' })}
        </button>
      ) : null}
      <button type="button" aria-expanded={open} aria-controls={menuId} onMouseDown={keep} onClick={() => setOpen((o) => !o)} disabled={busy}>
        {at.kind === 'reply' ? null : <Avatar kind="agent" name="assistant" small />}
        {t('writing.help')}
      </button>
    </>
  );

  const panel = (
    <>
      <div id={menuId} className="cluster" role="group" aria-label={t('writing.forTheWholeText')} hidden={!open}>
        {EDITS.map((a) => (
          <button key={a} type="button" disabled={busy || empty} onClick={() => void ask(a, 'all')}>
            {t('writing.action', { action: a })}
          </button>
        ))}
        <button type="button" disabled={busy || empty} onClick={() => void ask('continue', 'all')}>
          {t('writing.action', { action: 'continue' })}
        </button>
        {at.kind === 'reply' ? null : (
          <button type="button" disabled={busy || empty} onClick={() => void ask('draft', 'all')}>
            {t('writing.draft', { kind: at.kind })}
          </button>
        )}
      </div>
      {selected ? (
        <div className="cluster" role="group" aria-label={t('writing.selectedText')}>
          <span className="note">{t('writing.selected')}</span>
          {EDITS.map((a) => (
            <button key={a} type="button" disabled={busy} onMouseDown={keep} onClick={() => void ask(a, 'selection')}>
              {t('writing.action', { action: a })}
            </button>
          ))}
          <button type="button" disabled={busy} onMouseDown={keep} onClick={() => void summarise()}>
            {t('writing.summarise')}
          </button>
        </div>
      ) : null}
      {asked && busy ? (
        <p className="note" role="status">
          {t('writing.working')}
        </p>
      ) : null}
      {asked?.kind === 'write' && asked.text !== undefined ? (
        <SuggestionCard action={asked.action} original={asked.original} text={asked.text} error={asked.error} onAccept={accept} onDiscard={() => close(t('writing.discarded'))} />
      ) : null}
      {asked?.kind === 'write' && asked.text === undefined && asked.error ? <ErrorLine>{asked.error}</ErrorLine> : null}
      {asked?.kind === 'summary' && asked.summary ? (
        <SummaryCard label={t('writing.summaryOfTheSelection')} did={t('writing.summarisedTheSelection')} summary={asked.summary.summary} note={t('writing.shownNotSaved')} onClose={() => close()} />
      ) : null}
      {asked?.kind === 'summary' && asked.error ? <ErrorLine>{asked.error}</ErrorLine> : null}
    </>
  );
  return { button, panel };
}

/** What follows a text, joined to it: in its sentence when it stopped mid-way, else as a paragraph of its own. */
export function carriedOn(text: string, next: string): string {
  const kept = text.replace(/\s+$/, '');
  if (!kept) return next;
  return /[.!?:;)\]」。！？]$/.test(kept) || /\n\s*$/.test(text) ? `${kept}\n\n${next}` : `${kept} ${next}`;
}

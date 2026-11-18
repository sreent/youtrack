/**
 * What a whiteboard asks in the browser's own dialog (D58): a note's words and tone, a text, a card's
 * issue or article, the two ends of an arrow, and which notes and arrows become issues and links. A
 * dialog keeps the focus in it and gives it back on Escape, from the keyboard and on a phone alike.
 */
import type { Project, WhiteboardConvertResult, WhiteboardElement, WhiteboardTone } from '@a4a/shared';
import { WHITEBOARD_LIMITS, WHITEBOARD_TONES } from '@a4a/shared/constants';
import { useEffect, useId, useRef, useState } from 'react';
import { useLinkTypes, useProjects } from '../../api/queries';
import { ErrorLine, ErrorNote } from '../../components/States';
import { FormField } from '../common/bits';
import { problemSaid, t } from '../../i18n';
import { convertWhiteboard } from './api';
import { TONE_KEY } from './model';

/** The browser's own modal dialog, open while `open` is. */
function Modal({ open, onClose, title, children, about }: { open: boolean; onClose: () => void; title: string; about?: string; children: React.ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null);
  const id = useId();
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);
  return (
    <dialog ref={ref} className="dialog" aria-labelledby={`${id}-title`} aria-describedby={about ? `${id}-about` : undefined} onClose={onClose}>
      <h2 id={`${id}-title`}>{title}</h2>
      {about ? <p id={`${id}-about`}>{about}</p> : null}
      {open ? children : null}
    </dialog>
  );
}

export function NoteDialog({
  open,
  title,
  initial,
  conflict,
  onSave,
  onClose,
}: {
  open: boolean;
  title: string;
  initial: { text: string; tone: WhiteboardTone };
  /** Someone changed the note while it was being written: their words, kept beside these. */
  conflict?: string | null;
  onSave: (text: string, tone: WhiteboardTone) => void;
  onClose: () => void;
}) {
  const [text, setText] = useState(initial.text);
  const [tone, setTone] = useState<WhiteboardTone>(initial.tone);
  const name = useId();
  useEffect(() => {
    if (open) {
      setText(initial.text);
      setTone(initial.tone);
    }
    // A conflict keeps what's in the box: only opening starts again.
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <Modal open={open} onClose={onClose} title={title}>
      <form
        className="form"
        onSubmit={(e) => {
          e.preventDefault();
          onSave(text, tone);
        }}
      >
        {conflict !== undefined && conflict !== null ? <ErrorLine>{t('whiteboards.noteDialog.changedMeanwhile', { words: conflict })}</ErrorLine> : null}
        <FormField label={t('whiteboards.noteDialog.words')} help={t('whiteboards.noteDialog.firstLine')}>
          {(id, help) => <textarea id={id} aria-describedby={help} rows={5} maxLength={WHITEBOARD_LIMITS.text} value={text} autoFocus onChange={(e) => setText(e.target.value)} />}
        </FormField>
        <fieldset className="choice-group">
          <legend>{t('whiteboards.noteDialog.tone')}</legend>
          {WHITEBOARD_TONES.map((v) => (
            <label key={v} className="choice">
              <input type="radio" name={name} checked={tone === v} onChange={() => setTone(v)} />
              <span>{t(TONE_KEY[v])}</span>
            </label>
          ))}
        </fieldset>
        <div className="dialog-actions">
          <button type="button" onClick={onClose}>
            {t('whiteboards.dialog.cancel')}
          </button>
          <button type="submit" className="primary">
            {t('whiteboards.dialog.save')}
          </button>
        </div>
      </form>
    </Modal>
  );
}

export function TextDialog({
  open,
  title,
  label,
  initial,
  max,
  onSave,
  onClose,
}: {
  open: boolean;
  title: string;
  label: string;
  initial: string;
  max: number;
  onSave: (text: string) => void;
  onClose: () => void;
}) {
  const [text, setText] = useState(initial);
  useEffect(() => {
    if (open) setText(initial);
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <Modal open={open} onClose={onClose} title={title}>
      <form
        className="form"
        onSubmit={(e) => {
          e.preventDefault();
          onSave(text.trim());
        }}
      >
        <FormField label={label}>{(id) => <input id={id} maxLength={max} value={text} autoFocus onChange={(e) => setText(e.target.value)} />}</FormField>
        <div className="dialog-actions">
          <button type="button" onClick={onClose}>
            {t('whiteboards.dialog.cancel')}
          </button>
          <button type="submit" className="primary">
            {t('whiteboards.dialog.save')}
          </button>
        </div>
      </form>
    </Modal>
  );
}

export function CardDialog({ open, onAdd, onClose }: { open: boolean; onAdd: (kind: 'issue' | 'article', ref: string) => Promise<void>; onClose: () => void }) {
  const [kind, setKind] = useState<'issue' | 'article'>('issue');
  const [ref, setRef] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const name = useId();
  useEffect(() => {
    if (open) {
      setRef('');
      setError(null);
    }
  }, [open]);
  return (
    <Modal open={open} onClose={onClose} title={t('whiteboards.cardDialog.title')}>
      <form
        className="form"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setError(null);
          try {
            await onAdd(kind, ref.trim());
          } catch (err) {
            setError(err);
          } finally {
            setBusy(false);
          }
        }}
      >
        <fieldset className="choice-group">
          <legend>{t('whiteboards.cardDialog.what')}</legend>
          <label className="choice">
            <input type="radio" name={name} checked={kind === 'issue'} onChange={() => setKind('issue')} />
            <span>{t('whiteboards.cardDialog.issue')}</span>
          </label>
          <label className="choice">
            <input type="radio" name={name} checked={kind === 'article'} onChange={() => setKind('article')} />
            <span>{t('whiteboards.cardDialog.article')}</span>
          </label>
        </fieldset>
        <FormField label={t('whiteboards.cardDialog.id')} help={t('whiteboards.cardDialog.idHint')}>
          {(id, help) => <input id={id} aria-describedby={help} className="mono" required maxLength={40} value={ref} autoFocus autoComplete="off" spellCheck={false} onChange={(e) => setRef(e.target.value)} />}
        </FormField>
        {error ? <ErrorNote error={error} /> : null}
        <div className="dialog-actions">
          <button type="button" onClick={onClose}>
            {t('whiteboards.dialog.cancel')}
          </button>
          <button type="submit" className="primary" disabled={busy || !ref.trim()}>
            {t('whiteboards.dialog.add')}
          </button>
        </div>
      </form>
    </Modal>
  );
}

export function ConnectDialog({
  open,
  options,
  initial,
  onConnect,
  onClose,
}: {
  open: boolean;
  /** What an arrow may join, in reading order, each in words. */
  options: { id: string; words: string }[];
  initial: { from: string; to: string };
  onConnect: (from: string, to: string, label: string) => void;
  onClose: () => void;
}) {
  const [from, setFrom] = useState(initial.from);
  const [to, setTo] = useState(initial.to);
  const [label, setLabel] = useState('');
  useEffect(() => {
    if (open) {
      setFrom(initial.from);
      setTo(initial.to);
      setLabel('');
    }
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps
  const same = Boolean(from) && from === to;
  const pick = (value: string, set: (v: string) => void, label: string) => (
    <FormField label={label}>
      {(id) => (
        <select id={id} value={value} required onChange={(e) => set(e.target.value)}>
          <option value="">{t('whiteboards.connectDialog.choose')}</option>
          {options.map((o) => (
            <option key={o.id} value={o.id}>
              {o.words}
            </option>
          ))}
        </select>
      )}
    </FormField>
  );
  return (
    <Modal open={open} onClose={onClose} title={t('whiteboards.connectDialog.title')}>
      <form
        className="form"
        onSubmit={(e) => {
          e.preventDefault();
          if (from && to && !same) onConnect(from, to, label.trim());
        }}
      >
        {pick(from, setFrom, t('whiteboards.connectDialog.from'))}
        {pick(to, setTo, t('whiteboards.connectDialog.to'))}
        {same ? <ErrorLine>{t('whiteboards.connectDialog.same')}</ErrorLine> : null}
        <FormField label={t('whiteboards.connectDialog.label')}>{(id) => <input id={id} maxLength={WHITEBOARD_LIMITS.label} value={label} onChange={(e) => setLabel(e.target.value)} />}</FormField>
        <div className="dialog-actions">
          <button type="button" onClick={onClose}>
            {t('whiteboards.dialog.cancel')}
          </button>
          <button type="submit" className="primary" disabled={!from || !to || same}>
            {t('whiteboards.connectDialog.connect')}
          </button>
        </div>
      </form>
    </Modal>
  );
}

/** The link phrases, as a person picks one: "depends on", "is required for", "relates to". */
function usePhrases(): string[] {
  const types = useLinkTypes().data ?? [];
  return [...new Set(types.flatMap((l) => (l.directed ? [l.outward, l.inward] : [l.outward])))];
}

export function ConvertDialog({
  open,
  board,
  defaultProject,
  notes,
  arrows,
  wordsOf,
  onDone,
  onClose,
}: {
  open: boolean;
  board: string;
  defaultProject: string;
  /** The notes chosen, to make issues of. */
  notes: WhiteboardElement[];
  /** Arrows among what's chosen, or from it, whose ends are or will be issues. */
  arrows: { arrow: WhiteboardElement; from: string; to: string }[];
  wordsOf: (e: WhiteboardElement) => string;
  onDone: (result: WhiteboardConvertResult) => void;
  onClose: () => void;
}) {
  const projects = (useProjects().data ?? []).filter((p: Project) => p.access.permissions.includes('create') && !p.archived);
  const phrases = usePhrases();
  const [project, setProject] = useState(defaultProject);
  const [take, setTake] = useState<Set<string>>(new Set());
  const [relation, setRelation] = useState<Record<string, string>>({});
  const [result, setResult] = useState<WhiteboardConvertResult | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!open) return;
    setTake(new Set([...notes.map((n) => n.id), ...arrows.map((a) => a.arrow.id)]));
    setRelation({});
    setResult(null);
    setError(null);
    setProject(projects.some((p) => p.key === defaultProject) ? defaultProject : (projects[0]?.key ?? ''));
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps
  const chosenNotes = notes.filter((n) => take.has(n.id));
  const chosenArrows = arrows.filter((a) => take.has(a.arrow.id));
  const relationOf = (id: string) => relation[id] ?? phrases.find((p) => p === 'relates to') ?? phrases[0] ?? '';
  const run = async (dryRun: boolean) => {
    setBusy(true);
    setError(null);
    try {
      const r = await convertWhiteboard(board, {
        ...(chosenNotes.length ? { project } : {}),
        notes: chosenNotes.map((n) => n.id),
        links: chosenArrows.map((a) => ({ arrow: a.arrow.id, relation: relationOf(a.arrow.id) })),
        dryRun,
      });
      setResult(r);
      if (!dryRun) onDone(r);
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };
  const toggle = (id: string) =>
    setTake((now) => {
      const next = new Set(now);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const said = (p: { message: string; said: { key: string; values?: Record<string, unknown> } }) => problemSaid(p.said as { key: string; values?: Record<string, string | number> }) ?? p.message;
  const lines = result
    ? [
        ...result.notes.map((n) => ({
          id: n.element,
          ok: n.ok,
          words: !n.ok
            ? said(n.problem!)
            : n.already
              ? t('whiteboards.convertDialog.already', { id: n.issue ?? 'none' })
              : result.dryRun
                ? t('whiteboards.convertDialog.wouldMake', { summary: n.summary ?? '' })
                : t('whiteboards.convertDialog.made', { id: n.issue ?? '', summary: n.summary ?? '' }),
        })),
        ...result.links.map((l) => ({
          id: l.element,
          ok: l.ok,
          words: !l.ok ? said(l.problem!) : result.dryRun ? (l.link ? t('whiteboards.convertDialog.wouldLink', { link: l.link }) : t('whiteboards.convertDialog.wouldLinkTheirIssues', { relation: l.relation ?? '' })) : l.made === false ? t('whiteboards.convertDialog.linkedAlready', { link: l.link ?? '' }) : t('whiteboards.convertDialog.linked', { link: l.link ?? '' }),
        })),
      ]
    : [];
  const named = new Map([...notes, ...arrows.map((a) => a.arrow)].map((e) => [e.id, e]));
  const nothing = !notes.length && !arrows.length;
  return (
    <Modal open={open} onClose={onClose} title={t('whiteboards.convertDialog.title')} about={t('whiteboards.convertDialog.about')}>
      {nothing ? (
        <>
          <p className="note">{t('whiteboards.convertDialog.none')}</p>
          <div className="dialog-actions">
            <button type="button" onClick={onClose}>
              {t('whiteboards.dialog.close')}
            </button>
          </div>
        </>
      ) : (
        <form
          className="form"
          onSubmit={(e) => {
            e.preventDefault();
            void run(false);
          }}
        >
          {notes.length ? (
            <>
              <FormField label={t('whiteboards.convertDialog.project')}>
                {(id) => (
                  <select id={id} value={project} required onChange={(e) => setProject(e.target.value)}>
                    {projects.map((p) => (
                      <option key={p.key} value={p.key}>
                        {`${p.name} (${p.key})`}
                      </option>
                    ))}
                  </select>
                )}
              </FormField>
              <fieldset className="choice-group column">
                <legend>{t('whiteboards.convertDialog.notes')}</legend>
                {notes.map((n) => (
                  <label key={n.id} className="choice">
                    <input type="checkbox" checked={take.has(n.id)} onChange={() => toggle(n.id)} />
                    <span>{wordsOf(n)}</span>
                  </label>
                ))}
              </fieldset>
            </>
          ) : null}
          {arrows.length ? (
            <fieldset className="choice-group column">
              <legend>{t('whiteboards.convertDialog.arrows')}</legend>
              {arrows.map((a) => (
                <div key={a.arrow.id} className="stack">
                  <label className="choice">
                    <input type="checkbox" checked={take.has(a.arrow.id)} onChange={() => toggle(a.arrow.id)} />
                    <span>{t('whiteboards.convertDialog.arrowWords', { from: a.from, to: a.to })}</span>
                  </label>
                  <FormField label={t('whiteboards.convertDialog.relation', { from: a.from, to: a.to })}>
                    {(id) => (
                      <select id={id} value={relationOf(a.arrow.id)} disabled={!take.has(a.arrow.id)} onChange={(e) => setRelation((r) => ({ ...r, [a.arrow.id]: e.target.value }))}>
                        {phrases.map((p) => (
                          <option key={p} value={p}>
                            {p}
                          </option>
                        ))}
                      </select>
                    )}
                  </FormField>
                </div>
              ))}
            </fieldset>
          ) : null}
          {error ? <ErrorNote error={error} /> : null}
          {lines.length ? (
            <ul className="stack" aria-live="polite">
              {lines.map((l) => (
                <li key={l.id} className={l.ok ? undefined : 'error-note'}>
                  <strong>{named.get(l.id) ? wordsOf(named.get(l.id)!) : l.id}</strong> {l.words}
                </li>
              ))}
            </ul>
          ) : null}
          <div className="dialog-actions">
            <button type="button" onClick={onClose}>
              {result && !result.dryRun ? t('whiteboards.dialog.close') : t('whiteboards.dialog.cancel')}
            </button>
            <button type="button" disabled={busy || (!chosenNotes.length && !chosenArrows.length) || (chosenNotes.length > 0 && !project)} onClick={() => void run(true)}>
              {t('whiteboards.convertDialog.preview')}
            </button>
            <button type="submit" className="primary" disabled={busy || (!chosenNotes.length && !chosenArrows.length) || (chosenNotes.length > 0 && !project) || Boolean(result && !result.dryRun)}>
              {t('whiteboards.convertDialog.go', { notes: chosenNotes.length, links: chosenArrows.length })}
            </button>
          </div>
        </form>
      )}
    </Modal>
  );
}

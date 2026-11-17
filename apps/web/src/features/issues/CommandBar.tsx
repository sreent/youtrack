import type { CommandResult, NLCommandResult, QueryProblem, SuggestItem } from '@a4a/shared';
import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { ApiError, post } from '../../api/client';
import { useAIStatus } from '../../api/queries';
import { ChangeLines } from '../../components/Changes';
import { Who } from '../../components/Who';
import { LanguageField, useLanguage, type Checker } from './LanguageField';
import { ErrorLine } from '../../components/States';
import { t, tr, problemWords } from '../../i18n';

interface Props {
  /** Readable ids and summaries, e.g. { id: 'BACK-12', summary: 'Login times out' }. */
  issues: { id: string; summary: string }[];
  open: boolean;
  onClose: () => void;
  onApplied?: () => void;
  /** A command to start from, e.g. "State In Progress". */
  initial?: string;
}

type Preview = CommandResult & { description?: string };

/** "BACK-12, BACK-15 and BACK-19", with the ids in mono. */
function IdList({ ids }: { ids: string[] }) {
  const shown = ids.length > 6 ? ids.slice(0, 5) : ids;
  const rest = ids.length - shown.length;
  return (
    <>
      {shown.map((id, i) => (
        <span key={id}>
          {i > 0 ? (i === shown.length - 1 && !rest ? ' and ' : ', ') : null}
          <span className="issue-id">{id}</span>
        </span>
      ))}
      {rest ? t('issues.commandBar.andMore', { rest: rest }) : null}
    </>
  );
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/**
 * Ocean's CommandBar: a command for the issues someone chose, in the browser's own dialog.
 * What it changes is shown on each issue before anything changes; nothing does until the
 * person applies it, whether they typed the command or an agent read it from their words.
 */
export function CommandBar({ issues, open, onClose, onApplied, initial }: Props) {
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const qc = useQueryClient();
  const ai = useAIStatus();
  const ids = useMemo(() => issues.map((i) => i.id), [issues]);
  const summaries = useMemo(() => new Map(issues.map((i) => [i.id, i.summary])), [issues]);

  const [text, setText] = useState(initial ?? '');
  const [words, setWords] = useState(false);
  const [read, setRead] = useState<NLCommandResult | null>(null);
  const [comment, setComment] = useState('');
  const [preview, setPreview] = useState<{ command: string; result: Preview } | null>(null);
  const [busy, setBusy] = useState<'reading' | 'applying' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [failed, setFailed] = useState<CommandResult['results']>([]);

  const check: Checker = useCallback(
    async (command, caret) => {
      const r = await post<{ problems: QueryProblem[]; description: string; suggestions: SuggestItem[] }>('/commands/parse', { issues: ids, command, caret });
      return { problems: r.problems, about: r.description, suggestions: r.suggestions };
    },
    [ids],
  );
  const lang = useLanguage(check, text, open && !words && text.trim() !== '');

  // Open and close with the dialog's own API: it keeps the focus in it and closes on Escape.
  useEffect(() => {
    const d = dialog.current;
    if (!d) return;
    if (open && !d.open) {
      setText(initial ?? '');
      setWords(false);
      setRead(null);
      setComment('');
      setPreview(null);
      setError(null);
      setFailed([]);
      d.showModal();
    } else if (!open && d.open) d.close();
  }, [open, initial]);

  // The command in force: what the person typed, or what the agent read their words as.
  const command = words ? (read?.command ?? '') : text.trim();
  const viaAssistant = read !== null && command === read.command.trim();
  const problems = words ? [] : lang.problems;

  // Preview what the typed command changes, once it reads cleanly.
  useEffect(() => {
    if (!open || words) return;
    if (!command || !lang.checked || lang.problems.length) return;
    let live = true;
    const timer = setTimeout(() => {
      post<Preview>('/commands', { issues: ids, command, dryRun: true })
        .then((result) => live && setPreview({ command, result }))
        .catch((e) => live && setError(e instanceof ApiError ? (problemWords(e) ?? e.message) : t('issues.commandBar.couldNotPreviewTheCommand')));
    }, 220);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [open, words, command, ids, lang.checked, lang.problems.length]);

  const current = preview && preview.command === command ? preview.result : words && read ? read.preview : null;
  const changing = current ? current.results.filter((r) => r.changes.length > 0).length : 0;
  const errors = current ? current.results.flatMap((r) => r.errors.map((e) => `${r.issue}: ${e}`)) : [];

  const askWords = async () => {
    if (!text.trim()) return;
    setBusy('reading');
    setError(null);
    try {
      const res = await post<NLCommandResult>('/ai/command', { text, issues: ids });
      setRead(res);
      if (res.comment && !comment) setComment(res.comment);
    } catch (e) {
      setError(e instanceof ApiError ? (problemWords(e) ?? `${e.message}${e.hint ? `. ${e.hint}` : ''}`) : t('issues.commandBar.theAssistantCouldNotRead'));
    } finally {
      setBusy(null);
    }
  };

  const apply = async () => {
    if (!command && !comment.trim()) return;
    setBusy('applying');
    setError(null);
    try {
      const res = await post<Preview>('/commands', {
        issues: ids,
        command,
        comment: comment.trim() || undefined,
        readBy: viaAssistant ? 'assistant' : undefined,
      });
      await Promise.all([
        qc.invalidateQueries({ queryKey: ['issues'] }),
        qc.invalidateQueries({ queryKey: ['boards'] }),
        qc.invalidateQueries({ queryKey: ['plan'] }),
      ]);
      const bad = res.results.filter((r) => r.errors.length);
      if (bad.length) {
        setFailed(bad);
        return;
      }
      onApplied?.();
      onClose();
    } catch (e) {
      setError(e instanceof ApiError ? (problemWords(e) ?? `${e.message}${e.hint ? `. ${e.hint}` : ''}`) : t('issues.commandBar.couldNotApplyTheCommand'));
    } finally {
      setBusy(null);
    }
  };

  const hint = problems.length
    ? t('issues.commandBar.itAppliesOnceTheProblem')
    : words && !read
      ? t('issues.commandBar.sayWhatToDoThen')
      : command && current && !changing && !comment.trim()
        ? t('issues.commandBar.thisChangesNothingOnThese')
        : null;
  const ready = !busy && !problems.length && (current !== null ? changing > 0 || !!comment.trim() : !command && !!comment.trim());
  const applyLabel = issues.length === 1 ? t('issues.commandBar.applyTo', { id: issues[0]!.id }) : t('issues.commandBar.applyToIssues', { n: issues.length });

  return (
    <dialog ref={dialog} className="dialog command" aria-labelledby={titleId} onClose={onClose}>
      <h2 id={titleId}>{t('issues.commandBar.applyACommand')}</h2>
      <p className="command-to">{tr('issues.commandBar.toIssues', { n: issues.length, el: <IdList ids={ids} /> })}</p>
      <div className="query">
        <LanguageField
          text={text}
          onText={(t) => {
            setText(t);
            if (words) setRead(null);
          }}
          onCaret={lang.setCaret}
          onEnter={() => (words ? void askWords() : ready ? void apply() : undefined)}
          label={words ? t('issues.commandBar.sayWhatToDoIn') : t('issues.commandBar.command')}
          placeholder={words ? t('issues.commandBar.moveTheseToReviewAnd') : t('issues.commandBar.stateFixedForMeTag')}
          problems={problems}
          suggestions={words ? [] : lang.suggestions}
          words={words}
          autoFocus
          ask={{
            pressed: words,
            disabled: !ai.data?.enabled,
            title: ai.data?.enabled ? t('issues.commandBar.anAgentTurnsYourWords') : t('issues.commandBar.aiIsOffOnThis'),
            onToggle: () => {
              setWords((w) => !w);
              setText(words ? (read?.command ?? '') : '');
              setError(null);
            },
          }}
        />
        {busy === 'reading' ? (
          <p className="query-found" role="status">{t('issues.commandBar.readingYourWords')}</p>
        ) : null}
        {read && (words || viaAssistant) ? (
          <p className="query-read">
            <Who kind="agent" name="assistant" small />
            <span>{t('issues.commandBar.interpretedAs')}</span>
            <code>{read.command || t('issues.commandBar.noChange')}</code>
            {words ? (
              <button
                type="button"
                className="link"
                onClick={() => {
                  setWords(false);
                  setText(read.command);
                }}
              >{t('issues.commandBar.edit')}</button>
            ) : null}
          </p>
        ) : null}
      </div>

      {current && command ? (
        <div className="command-preview" role="group" aria-label={t('issues.commandBar.whatItChanges')}>
          <p className="label">{t('issues.commandBar.whatItChanges')}</p>
          <ul className="command-issues">
            {current.results.map((r) => (
              <li key={r.issue}>
                <span className="issue-id">{r.issue}</span>
                <span className="command-summary">{summaries.get(r.issue) ?? ''}</span>
                {r.changes.length ? <ChangeLines changes={r.changes} /> : <ChangeLines changes={[]} same={[t('issues.commandBar.nothingChanges')]} />}
                {r.errors.map((e) => (
                  <ErrorLine key={e}>{e}</ErrorLine>
                ))}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <label className="command-comment">{tr('issues.commandBar.aCommentIfYouWant', { el: <textarea value={comment} onChange={(e) => setComment(e.target.value)} /> })}</label>

      {error ? <ErrorLine>{error}</ErrorLine> : null}
      {failed.length ? <ErrorLine>{tr('issues.commandBar.someIssuesWerenTChanged', { join: failed.map((f) => `${f.issue} (${f.errors.join('; ')})`).join(', ') })}</ErrorLine> : null}

      <div className="dialog-actions">
        {hint ? <p className="command-hint">{hint}</p> : null}
        <button type="button" onClick={onClose}>{t('issues.commandBar.cancel')}</button>
        {words && !read ? (
          <button type="button" className="primary" disabled={!text.trim() || busy !== null} onClick={() => void askWords()}>
            {busy === 'reading' ? t('issues.commandBar.reading') : t('issues.commandBar.readMyWords')}
          </button>
        ) : (
          <button type="button" className="primary" disabled={!ready} onClick={() => void apply()}>
            {busy === 'applying' ? t('issues.commandBar.applying') : applyLabel}
          </button>
        )}
      </div>
    </dialog>
  );
}

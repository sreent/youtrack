import type { QueryProblem, ScriptRun } from '@a4a/shared';
import { scriptRunNote } from '@a4a/shared/notes';
import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { IssueLink } from '../../components/Badges';
import { Icon } from '../../components/Icon';
import { ErrorLine } from '../../components/States';
import { ChangeLines } from '../common/ChangeLines';
import { checkScript } from './api';
import { errorSaid, formatList, inPage, problemSaid, t, tr } from '../../i18n';

/** The line (from 1) that a place in the text is on. */
function lineAt(text: string, at: number): number {
  let n = 1;
  for (let i = 0; i < Math.min(at, text.length); i++) if (text[i] === '\n') n++;
  return n;
}

/** What stops a script compiling, as it's typed: checked on the server a moment after the last key. */
export function useScriptProblems(project: string | null, text: string, enabled = true): QueryProblem[] {
  const [problems, setProblems] = useState<{ text: string; problems: QueryProblem[] } | null>(null);
  useEffect(() => {
    if (!enabled || !text.trim()) return;
    let current = true;
    const timer = setTimeout(() => {
      checkScript(project, text)
        .then((p) => current && setProblems({ text, problems: p }))
        .catch(() => current && setProblems(null));
    }, 350);
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [project, text, enabled]);
  return enabled && text.trim() && problems?.text === text ? problems.problems : [];
}

/**
 * Ocean's script field: JavaScript in mono, line numbers in a gutter, each problem underlined where
 * it is and said beneath, as the query bar does. A textarea over a mirror of its text, which draws
 * the underlines and scrolls with it. Tab indents.
 */
export function ScriptField({ text, onText, problems, label, describedBy }: { text: string; onText: (t: string) => void; problems: QueryProblem[]; label: string; describedBy?: string }) {
  const id = useId();
  const mirror = useRef<HTMLPreElement>(null);
  const gutter = useRef<HTMLPreElement>(null);
  const lines = text.split('\n').length;
  const bad = new Set(problems.map((p) => lineAt(text, p.start)));
  const marked: ReactNode[] = [];
  let at = 0;
  for (const [i, p] of [...problems].sort((a, b) => a.start - b.start).entries()) {
    if (p.start < at) continue;
    marked.push(text.slice(at, p.start));
    marked.push(
      <mark key={i} className="query-problem">
        {text.slice(p.start, Math.max(p.end, p.start + 1)) || ' '}
      </mark>,
    );
    at = Math.max(p.end, p.start + 1);
  }
  marked.push(`${text.slice(at)}\n`);
  const problemIds = problems.map((_, i) => `${id}-p${i}`);
  return (
    <>
      <div className="script-field">
        <pre className="script-lines" aria-hidden="true" ref={gutter}>
          {Array.from({ length: lines }, (_, i) => (
            <span key={i} className={bad.has(i + 1) ? 'bad' : undefined}>
              {i + 1}
              {'\n'}
            </span>
          ))}
        </pre>
        <div className="script-body">
          <pre className="script-mirror" aria-hidden="true" ref={mirror}>
            {marked}
          </pre>
          <textarea
            className="script-input"
            aria-label={label}
            aria-invalid={problems.length > 0}
            aria-describedby={[describedBy, ...problemIds].filter(Boolean).join(' ') || undefined}
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            value={text}
            rows={Math.min(Math.max(lines + 1, 10), 24)}
            onChange={(e) => onText(e.target.value)}
            onScroll={(e) => {
              const t = e.currentTarget;
              if (mirror.current) {
                mirror.current.scrollTop = t.scrollTop;
                mirror.current.scrollLeft = t.scrollLeft;
              }
              if (gutter.current) gutter.current.scrollTop = t.scrollTop;
            }}
            onKeyDown={(e) => {
              if (e.key !== 'Tab' || e.shiftKey || e.altKey || e.metaKey || e.ctrlKey) return;
              e.preventDefault();
              const t = e.currentTarget;
              const { selectionStart: s, selectionEnd: end } = t;
              onText(`${text.slice(0, s)}  ${text.slice(end)}`);
              requestAnimationFrame(() => t.setSelectionRange(s + 2, s + 2));
            }}
          />
        </div>
      </div>
      {problems.map((p, i) => (
        <p className="query-problems" id={problemIds[i]} key={`${p.start}-${p.message}`}>
          <Icon name="cross" />
          <strong>{problemSaid(p) ?? p.message}</strong>
          {p.hint && !problemSaid(p) ? (
            <>
              <span aria-hidden="true">·</span>
              <span>{p.hint}</span>
            </>
          ) : null}
        </p>
      ))}
    </>
  );
}

/** Ocean's script run: what a script would do to one issue as it is now, from a dry run. */
export function ScriptRunView({ issue, run }: { issue: string; run: ScriptRun }) {
  return (
    <div className="script-run" role="group" aria-label={t('workflow.scriptField.whatItWouldDoTo', { issue: issue })}>
      <p className="label">{tr('workflow.scriptField.whatItWouldDoTo2', { el: <IssueLink id={issue} /> })}</p>
      {run.error ? <ErrorLine>{problemSaid(run.error) ?? run.error.message}</ErrorLine> : null}
      {run.logs.length ? <pre className="script-log">{run.logs.join('\n')}</pre> : null}
      {run.refusal !== null ? <p>{tr('workflow.scriptField.itRefuses', { refusal: run.refusal })}</p> : null}
      {run.applies.length ? (
        <ul className="script-applies">
          {run.applies.map((a, i) => (
            <li key={`${i}-${a.command}`}>
              <span>
                <code>{a.command}</code>
                {a.issue && a.issue.id !== issue ? (
                  <>{tr('workflow.scriptField.on', { el: <IssueLink id={a.issue.id} /> })}</>
                ) : null}
              </span>
              {a.changes.length ? <ChangeLines changes={a.changes} /> : null}
              {a.errors.map((e, j) => (
                <p key={e} className="note">
                  {errorSaid(a.errorWords?.[j], e)}
                </p>
              ))}
            </li>
          ))}
        </ul>
      ) : null}
      {run.comments.length ? <p className="note">{tr('workflow.scriptField.itWouldComment', { join: formatList(run.comments.map((c) => `“${c}”`)) })}</p> : null}
      <p className="note">{tr('workflow.scriptField.itTookMs', { note: inPage((page) => scriptRunNote(page, run)), ms: run.ms })}</p>
    </div>
  );
}

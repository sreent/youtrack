import type { QueryProblem, SuggestItem } from '@a4a/shared';
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { Avatar } from '../../components/Who';
import { Icon } from '../../components/Icon';

/**
 * What the server says about some text: its problems, a reading of it in words, and what
 * could come next at the caret. Queries and commands each have their own checker.
 */
export interface Reading {
  problems: QueryProblem[];
  about: string;
  suggestions: SuggestItem[];
}
export type Checker = (text: string, caret: number) => Promise<Reading>;

/** Text with a fix applied in place of the problem's span. */
export function applyFix(text: string, p: QueryProblem): string {
  return text.slice(0, p.start) + (p.fix ?? '') + text.slice(p.end);
}

/**
 * The field, its problems and its suggestions, as Ocean's QueryBar draws them. The text
 * is the caller's; the field checks it as it changes (debounced, latest wins) and keeps
 * what it learned about the text it was checking, so a stale answer never underlines
 * the wrong letters.
 */
export function useLanguage(check: Checker, text: string, enabled = true) {
  const [reading, setReading] = useState<(Reading & { text: string }) | null>(null);
  const [caret, setCaret] = useState(text.length);
  const seq = useRef(0);

  const run = useCallback(
    async (t: string, at: number): Promise<Reading> => {
      const id = ++seq.current;
      const r = await check(t, at);
      if (id === seq.current) setReading({ ...r, text: t });
      return r;
    },
    [check],
  );

  useEffect(() => {
    if (!enabled) return;
    const timer = setTimeout(() => void run(text, caret).catch(() => {}), 160);
    return () => clearTimeout(timer);
  }, [text, caret, enabled, run]);

  const current = reading && reading.text === text ? reading : null;
  return {
    problems: current?.problems ?? [],
    about: current?.about ?? '',
    suggestions: current?.suggestions ?? [],
    checked: current !== null,
    setCaret,
    /** Check now (on submit), without waiting for the debounce. */
    checkNow: () => run(text, caret),
  };
}

function Mirror({ text, problems }: { text: string; problems: QueryProblem[] }) {
  const parts: React.ReactNode[] = [];
  let at = 0;
  [...problems]
    .sort((a, b) => a.start - b.start)
    .forEach((p, i) => {
      const start = Math.max(p.start, at);
      // A problem at the very end ("expected a value") still gets a mark you can see.
      const end = Math.min(text.length, Math.max(p.end, start));
      if (start > at) parts.push(text.slice(at, start));
      parts.push(
        <mark key={i} className="query-problem">
          {end > start ? text.slice(start, end) : ' '}
        </mark>,
      );
      at = Math.max(at, end);
    });
  if (at < text.length) parts.push(text.slice(at));
  return <>{parts}</>;
}

function Highlight({ label, typed }: { label: string; typed: string }) {
  const t = typed.trim().replace(/^[#{"-]+/, '');
  const i = t ? label.toLowerCase().indexOf(t.toLowerCase()) : -1;
  if (i < 0) return <span>{label}</span>;
  return (
    <span>
      {label.slice(0, i)}
      <mark>{label.slice(i, i + t.length)}</mark>
      {label.slice(i + t.length)}
    </span>
  );
}

const KIND_WORDS: Record<SuggestItem['kind'], string> = {
  field: 'field',
  value: 'value',
  keyword: 'keyword',
  user: 'person',
  tag: 'tag',
  project: 'project',
  issue: 'issue',
  sort: 'sort',
};

interface FieldProps {
  text: string;
  onText: (text: string) => void;
  onCaret: (caret: number) => void;
  onEnter: () => void;
  label: string;
  placeholder?: string;
  problems: QueryProblem[];
  suggestions: SuggestItem[];
  /** Asking in words: plain words, no underlines, no suggestions. */
  words?: boolean;
  /** "Ask in words", when the server has AI. */
  ask?: { pressed: boolean; onToggle: () => void; disabled?: boolean; title?: string };
  autoFocus?: boolean;
  inputRef?: React.RefObject<HTMLInputElement | null>;
}

/** Ocean's QueryBar row, its problems and its suggestions (the caller wraps them in `.query`). */
export function LanguageField({ text, onText, onCaret, onEnter, label, placeholder, problems, suggestions, words, ask, autoFocus, inputRef }: FieldProps) {
  const id = useId();
  const ownRef = useRef<HTMLInputElement>(null);
  const input = inputRef ?? ownRef;
  const mirror = useRef<HTMLSpanElement>(null);
  const [focused, setFocused] = useState(false);
  const [active, setActive] = useState(-1);
  const [dismissed, setDismissed] = useState(false);
  const shown = words ? [] : problems;
  const open = focused && !words && !dismissed && suggestions.length > 0;
  const listId = `${id}-options`;
  const problemIds = shown.map((_, i) => `${id}-p${i}`);

  useEffect(() => setActive(-1), [suggestions]);

  // The mirror sits behind the input; keep it scrolled with it so the underline stays under its letters.
  const sync = () => {
    if (mirror.current && input.current) mirror.current.scrollLeft = input.current.scrollLeft;
  };
  useLayoutEffect(sync);

  const take = (item: SuggestItem) => {
    const next = text.slice(0, item.replaceStart) + item.insert + text.slice(item.replaceEnd);
    const caret = item.replaceStart + item.insert.length;
    onText(next);
    onCaret(caret);
    setDismissed(false);
    requestAnimationFrame(() => {
      input.current?.focus();
      input.current?.setSelectionRange(caret, caret);
      sync();
    });
  };

  const fix = (p: QueryProblem) => {
    const next = applyFix(text, p);
    const caret = p.start + (p.fix ?? '').length;
    onText(next);
    onCaret(caret);
    requestAnimationFrame(() => {
      input.current?.focus();
      input.current?.setSelectionRange(caret, caret);
      sync();
    });
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (open) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        const n = suggestions.length;
        setActive((a) => (e.key === 'ArrowDown' ? (a + 1) % n : (a - 1 + n) % n));
        return;
      }
      // Tab takes the highlighted suggestion (or the first); Enter only one the person moved to.
      if (e.key === 'Tab' && !e.shiftKey) {
        e.preventDefault();
        take(suggestions[Math.max(active, 0)]!);
        return;
      }
      if (e.key === 'Enter' && active >= 0) {
        e.preventDefault();
        take(suggestions[active]!);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        setDismissed(true);
        return;
      }
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      setDismissed(true);
      onEnter();
    }
  };

  const caretOf = (el: HTMLInputElement) => el.selectionStart ?? el.value.length;

  return (
    <>
      <div className="query-row">
        <div className={words ? 'query-field words' : 'query-field'}>
          <span className="query-mirror" aria-hidden="true" ref={mirror}>
            {words ? text : <Mirror text={text} problems={shown} />}
          </span>
          <input
            ref={input}
            type="text"
            className="query-input"
            role="combobox"
            aria-label={label}
            aria-autocomplete="list"
            aria-expanded={open}
            aria-controls={open ? listId : undefined}
            aria-activedescendant={open && active >= 0 ? `${listId}-${active}` : undefined}
            aria-invalid={shown.length > 0 || undefined}
            aria-describedby={problemIds.length ? problemIds.join(' ') : undefined}
            value={text}
            placeholder={placeholder}
            autoComplete="off"
            spellCheck={false}
            enterKeyHint="search"
            autoFocus={autoFocus}
            onChange={(e) => {
              onText(e.target.value);
              onCaret(caretOf(e.target));
              setDismissed(false);
            }}
            onSelect={(e) => {
              onCaret(caretOf(e.currentTarget));
              sync();
            }}
            onScroll={sync}
            onFocus={() => setFocused(true)}
            onBlur={() => setFocused(false)}
            onKeyDown={onKeyDown}
          />
        </div>
        {ask ? (
          <button type="button" className="query-ask" aria-pressed={ask.pressed} onClick={ask.onToggle} disabled={ask.disabled} title={ask.title}>
            <Avatar kind="agent" name="assistant" small />
            <span className="query-ask-words">Ask in words</span>
          </button>
        ) : null}
      </div>
      {shown.map((p, i) => (
        <p className="query-problems" id={problemIds[i]} key={`${p.start}-${p.end}-${p.message}`}>
          <Icon name="cross" />
          <strong>{p.message}</strong>
          {p.fix !== undefined ? (
            <>
              <span aria-hidden="true">·</span>
              <span>
                Did you mean{' '}
                <button type="button" className="link" onClick={() => fix(p)}>
                  {p.fix}
                </button>
                ?
              </span>
            </>
          ) : p.hint ? (
            <>
              <span aria-hidden="true">·</span>
              <span>{p.hint}</span>
            </>
          ) : null}
        </p>
      ))}
      {open ? (
        <ul className="popover options" id={listId} role="listbox" aria-label="Suggestions">
          {suggestions.map((s, i) => (
            <li
              key={`${s.kind}-${s.label}-${i}`}
              id={`${listId}-${i}`}
              role="option"
              aria-selected={i === active}
              // Keep the focus in the field: choosing must not blur it first.
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => take(s)}
              onMouseEnter={() => setActive(i)}
            >
              <Highlight label={s.label} typed={text.slice(s.replaceStart, s.replaceEnd)} />
              <span className="option-kind">{s.description ?? KIND_WORDS[s.kind]}</span>
            </li>
          ))}
        </ul>
      ) : null}
    </>
  );
}

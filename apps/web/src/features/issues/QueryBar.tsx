import type { NLQueryResult, QueryProblem, SuggestItem } from '@a4a/shared';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError, get, post, qs } from '../../api/client';
import { Who } from '../../components/Who';
import { LanguageField, useLanguage, type Checker } from './LanguageField';

export const checkQuery: Checker = async (text, caret) => {
  const [parsed, next] = await Promise.all([
    post<{ ok: boolean; problems: QueryProblem[]; explanation: string }>('/search/parse', { query: text }),
    get<{ items: SuggestItem[] }>(`/search/suggest${qs({ query: text, caret })}`),
  ]);
  return { problems: parsed.problems, about: parsed.explanation, suggestions: next.items };
};

/** "4 issues in project BACK, unresolved", from the count and the query read in words. */
export function foundLine(total: number, about: string): string {
  const count = `${total} ${total === 1 ? 'issue' : 'issues'}`;
  if (/^(all )?issues\b/i.test(about)) return count + about.replace(/^(all )?issues/i, '');
  return about ? `${count}: ${about}` : count;
}

interface Props {
  /** The query in force (the page's, from its address). */
  value: string;
  onSubmit: (query: string) => void;
  /** How many issues the query in force found, once it has. */
  found?: number | null;
  /** The project in view, to help the assistant read words. */
  project?: string;
  aiEnabled: boolean;
  label?: string;
  autoFocus?: boolean;
}

/** Ocean's QueryBar: the query language with its problems and suggestions, or plain words for an agent to read. */
export function QueryBar({ value, onSubmit, found, project, aiEnabled, label = 'Search issues', autoFocus }: Props) {
  const [text, setText] = useState(value);
  const [words, setWords] = useState(false);
  const [read, setRead] = useState<NLQueryResult | null>(null);
  const [asking, setAsking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const lang = useLanguage(checkQuery, text, !words);
  const [inForce, setInForce] = useState<{ text: string; about: string } | null>(null);

  // The query in force changed. If this bar sent it, keep what the person sees (their words
  // and what the agent read them as); if it came from elsewhere (a saved search, the back
  // button), show it.
  const sent = useRef<string | null>(null);
  useEffect(() => {
    const mine = sent.current === value;
    sent.current = null;
    if (mine) return;
    setText(value);
    setWords(false);
    setRead(null);
  }, [value]);
  const send = useCallback(
    (q: string) => {
      sent.current = q;
      onSubmit(q);
    },
    [onSubmit],
  );
  // Remember how the query in force reads, for the line that says what it found.
  useEffect(() => {
    if (!words && lang.checked && text === value) setInForce({ text, about: lang.about });
  }, [words, lang.checked, lang.about, text, value]);

  const submit = useCallback(async () => {
    setError(null);
    if (!words) {
      setRead(null);
      try {
        const r = await lang.checkNow();
        if (r.problems.length) return; // they're shown, underlined; nothing runs until they're fixed
      } catch {
        // can't check: let the search say what's wrong
      }
      send(text.trim());
      return;
    }
    if (!text.trim()) return;
    setAsking(true);
    try {
      const res = await post<NLQueryResult>('/ai/query', { text, project });
      setRead(res);
      if (res.valid) {
        send(res.query);
      } else {
        // The agent's query has a problem the person can see and fix: hand it over.
        setWords(false);
        setText(res.query);
      }
    } catch (e) {
      setError(e instanceof ApiError ? `${e.message}${e.hint ? `. ${e.hint}` : ''}` : 'The assistant could not read that.');
    } finally {
      setAsking(false);
    }
  }, [words, text, project, send, lang]);

  const toggleWords = () => {
    setWords((w) => !w);
    setError(null);
    if (!words) setText('');
    else setText(read?.query ?? value);
    requestAnimationFrame(() => input.current?.focus());
  };

  const about = read && read.valid && read.query === value ? read.explanation : inForce && inForce.text === value ? inForce.about : '';

  return (
    <div className="query">
      <LanguageField
        text={text}
        onText={setText}
        onCaret={lang.setCaret}
        onEnter={() => void submit()}
        label={words ? 'Ask in words' : label}
        placeholder={words ? 'critical bugs nobody has picked up this week' : 'project: BACK #Unresolved for: me'}
        problems={lang.problems}
        suggestions={lang.suggestions}
        words={words}
        inputRef={input}
        autoFocus={autoFocus}
        ask={{
          pressed: words,
          onToggle: toggleWords,
          disabled: !aiEnabled,
          title: aiEnabled ? 'An agent turns your words into a query' : 'AI is off on this server',
        }}
      />
      {asking ? (
        <p className="query-found" role="status">
          Reading your words…
        </p>
      ) : null}
      {read && !asking ? (
        <p className="query-read">
          <Who kind="agent" name="assistant" small />
          <span>Interpreted as:</span>
          <code>{read.query}</code>
          <button
            type="button"
            className="link"
            onClick={() => {
              setWords(false);
              setText(read.query);
              setRead(null);
              requestAnimationFrame(() => input.current?.focus());
            }}
          >
            Edit
          </button>
        </p>
      ) : null}
      {error ? (
        <p className="a4-error" role="alert">
          {error}
        </p>
      ) : null}
      {found !== undefined && found !== null && !asking ? (
        <p className="query-found" role="status">
          {foundLine(found, about)}
        </p>
      ) : null}
    </div>
  );
}

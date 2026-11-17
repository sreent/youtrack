import type { NLQueryResult, ParseQueryResult, QueryExplained, SuggestItem } from '@a4a/shared';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError, get, post, qs } from '../../api/client';
import { Who } from '../../components/Who';
import { LanguageField, useLanguage, type Checker } from './LanguageField';
import { ErrorLine } from '../../components/States';
import { t, problemWords } from '../../i18n';

export const checkQuery: Checker = async (text, caret) => {
  const [parsed, next] = await Promise.all([
    post<ParseQueryResult>('/search/parse', { query: text }),
    get<{ items: SuggestItem[] }>(`/search/suggest${qs({ query: text, caret })}`),
  ]);
  return { problems: parsed.problems, about: parsed.explanation, explained: parsed.explained, suggestions: next.items };
};

/**
 * "4 issues in project BACK, unresolved": the count, then what the query asks and how it sorts,
 * read by the server in the page's language. A query not read yet is its count alone.
 */
export function foundLine(total: number, explained: QueryExplained | null): string {
  if (!explained) return t('issues.queryBar.issues', { n: total });
  const { body, sort, zone } = explained;
  const line = body
    ? t('issues.queryBar.foundWhere', { n: total, body, sort })
    : sort
      ? t('issues.queryBar.foundSorted', { n: total, sort })
      : t('issues.queryBar.foundRecentFirst', { n: total });
  return zone ? t('issues.queryBar.foundDatesIn', { found: line, zone }) : line;
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
export function QueryBar({ value, onSubmit, found, project, aiEnabled, label = t('issues.queryBar.searchIssues'), autoFocus }: Props) {
  const [text, setText] = useState(value);
  const [words, setWords] = useState(false);
  const [read, setRead] = useState<NLQueryResult | null>(null);
  const [asking, setAsking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const lang = useLanguage(checkQuery, text, !words);
  const [inForce, setInForce] = useState<{ text: string; explained: QueryExplained | null } | null>(null);

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
    if (!words && lang.checked && text === value) setInForce({ text, explained: lang.explained });
  }, [words, lang.checked, lang.explained, text, value]);

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
      setError(e instanceof ApiError ? (problemWords(e) ?? `${e.message}${e.hint ? `. ${e.hint}` : ''}`) : t('issues.queryBar.theAssistantCouldNotRead'));
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

  const explained = read && read.valid && read.query === value ? read.explained : inForce && inForce.text === value ? inForce.explained : null;

  return (
    <div className="query">
      <LanguageField
        text={text}
        onText={setText}
        onCaret={lang.setCaret}
        onEnter={() => void submit()}
        label={words ? t('issues.queryBar.askInWords') : label}
        placeholder={words ? t('issues.queryBar.criticalBugsNobodyHasPicked') : t('issues.queryBar.projectBackUnresolvedForMe')}
        problems={lang.problems}
        suggestions={lang.suggestions}
        words={words}
        inputRef={input}
        autoFocus={autoFocus}
        ask={{
          pressed: words,
          onToggle: toggleWords,
          disabled: !aiEnabled,
          title: aiEnabled ? t('issues.queryBar.anAgentTurnsYourWords') : t('issues.queryBar.aiIsOffOnThis'),
        }}
      />
      {asking ? (
        <p className="query-found" role="status">{t('issues.queryBar.readingYourWords')}</p>
      ) : null}
      {read && !asking ? (
        <p className="query-read">
          <Who kind="agent" name="assistant" small />
          <span>{t('issues.queryBar.interpretedAs')}</span>
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
          >{t('issues.queryBar.edit')}</button>
        </p>
      ) : null}
      {error ? (
        <ErrorLine>{error}</ErrorLine>
      ) : null}
      {found !== undefined && found !== null && !asking ? (
        <p className="query-found" role="status">
          {foundLine(found, explained)}
        </p>
      ) : null}
    </div>
  );
}

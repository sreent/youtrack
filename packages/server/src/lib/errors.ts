import { isListSaid, sayProblem, type ListSaid, type ProblemSaid } from '@a4a/shared/i18n';
import { translatorFor } from '../i18n';

/** What a problem says in any language: its key under problem.* in the catalogs, and the values it takes (D49); a value may be another problem. */
export type ProblemWords = ProblemSaid;

export class AppError extends Error {
  /** Set by said(): a page in another language says the problem in it; the English stays for the API. */
  words?: ProblemWords;

  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly hint?: string,
    public readonly details?: unknown,
  ) {
    super(message);
  }

  /** The problem's key and values, for a page to say it in its person's language. */
  said(key: string, values?: ProblemSaid['values']): this {
    this.words = { key, values };
    return this;
  }
}

export const badRequest = (message: string, hint?: string, details?: unknown) =>
  new AppError(400, 'bad_request', message, hint, details);
export const unauthorized = (message?: string, hint?: string) => {
  const e = new AppError(401, 'unauthorized', message ?? 'Authentication required', hint);
  return message ? e : e.said('unauthorized');
};
export const forbidden = (message?: string, hint?: string) => {
  const e = new AppError(403, 'forbidden', message ?? 'You do not have permission to do this', hint);
  return message ? e : e.said('forbidden');
};
export const notFound = (what: string, hint?: string) => new AppError(404, 'not_found', `${what} not found`, hint);
export const conflict = (message: string, hint?: string, details?: unknown) =>
  new AppError(409, 'conflict', message, hint, details);
/** `key`: the variable that gives the configured provider its key (AI_PROVIDER: ANTHROPIC_API_KEY, DEEPSEEK_API_KEY…). */
export const aiDisabled = (key = 'ANTHROPIC_API_KEY') =>
  new AppError(503, 'ai_disabled', 'AI features are not configured on this server', `Set ${key} in the server environment and restart.`).said('aiDisabled', { key });

/**
 * Words of a problem's own that someone wrote (a script's refusal, a rule's message), ended as a
 * page's sentence ends them: the value a keyed problem places where the API puts them whole (D49).
 */
export const asSentence = (words: string): string => (/[.!?…:。！？]["”’)」』）]*$/.test(words.trim()) ? words.trim() : `${words.trim()}.`);

/** A problem as a page says it: its words, then its fix, each a sentence. */
const sentence = (s: string) => asSentence(s);
export const pageWords = (message: string, hint?: string) => (hint ? `${sentence(message)} ${sentence(hint)}` : sentence(message));

/** Problems a page says in general: the API adds what only a program reads (which field, as zod put it). */
const GENERAL = new Set(['validationFailed']);

/**
 * Whether a page's sentence and the API's say the same: the API ends no sentence after a quoted word
 * that ends in its own stop (`Unexpected ".."`, `Expected a value after "State:"`), where a catalog's
 * message, written once for every word, may (`Unexpected "{token}".`).
 */
export const readAlike = (a: string, b: string): boolean => {
  const plain = (s: string) => s.replace(/([.!?…:]["”’)]+)\./g, '$1');
  return plain(a) === plain(b);
};

/**
 * Under tests, a keyed problem's English in the catalog must say what the API says (D49): the two
 * are written apart, the API's where the problem is made and the page's in en.json, so a test that
 * meets the problem fails when one changes without the other. A list of words among the values is
 * joined as English joins items, ", ", as the API joins it. A list of problems is said whole on a
 * page, each with its fix, where the API joins their messages its own way: the problems in it are
 * checked where they're made.
 */
export function checkProblemWords(message: string, hint: string | undefined, words: ProblemWords): void {
  if (process.env.NODE_ENV !== 'test' || GENERAL.has(words.key)) return;
  if (Object.values(words.values ?? {}).some((v) => Array.isArray(v) && !isListSaid(v))) return;
  const en = translatorFor('en');
  const key = `problem.${words.key}`;
  if (!en.has(key)) throw new Error(`${key} is in no catalog: add its English to packages/shared/i18n/en.json`);
  const catalog = sayProblem(en, words);
  const api = pageWords(message, hint);
  if (!readAlike(catalog, api)) throw new Error(`${key} says "${catalog}" in en.json, but the API says "${api}": make them the same words`);
}

/** What a parser's problem says in any language: its key under problem.* and the words it takes, a list among them (D49). */
export type QueryProblemWords = { key: string; values?: Record<string, string | number | ListSaid> };

/**
 * A parser's problem (a QueryProblem: the query's, a command's, a rule's) with its words beside the
 * English it carries for the API (D49), so a page says it in its person's language. Its values are
 * the query's own words: a field's name, a value, a keyword, as written.
 */
export function keyedProblem<P extends { message: string; hint?: string }>(
  p: P,
  key: string,
  values?: Record<string, string | number | ListSaid>,
): P & QueryProblemWords {
  checkProblemWords(p.message, p.hint, { key, values });
  return values ? { ...p, key, values } : { ...p, key };
}

/**
 * A problem's words, carried where it's passed on as another (D49): a parser's, a script check's, or
 * an AppError's whose values are words, numbers and lists. Nothing when it has none, or holds another
 * problem.
 */
export function wordsOf(p: { key?: string; values?: Record<string, string | number | ListSaid> } | AppError): Partial<QueryProblemWords> {
  const w = p instanceof AppError ? p.words : p.key ? { key: p.key, values: p.values } : undefined;
  if (!w) return {};
  if (!w.values) return { key: w.key };
  if (Object.values(w.values).some((v) => typeof v === 'object' && !isListSaid(v))) return {};
  return { key: w.key, values: w.values as Record<string, string | number | ListSaid> };
}

/** The nearest known name, as a problem's words take it: "Did you mean …?" when there is one (D49). */
export const guessWords = (guess: string | null | undefined) => ({ hasGuess: guess ? 'yes' : 'no', guess: guess ?? '' });

type SaidAs = { message: string; hint?: string; key?: string; values?: Record<string, string | number | ListSaid> };

/**
 * A parser's problem as another problem's value, said whole with its fix on a page (D49): by its key,
 * or, for what has none (what the JavaScript engine says of a script), in the English it came in.
 */
export const saidProblem = (p: SaidAs): ProblemSaid =>
  p.key ? (p.values ? { key: p.key, values: p.values } : { key: p.key }) : { key: 'inItsOwnWords', values: { words: pageWords(p.message, p.hint) } };

/** A parser's problems as one problem's value: each said whole, with its fix, on a page (D49). */
export const saidProblems = (problems: readonly SaidAs[]): ProblemSaid[] => problems.map(saidProblem);

/**
 * What went wrong for one issue, as a page says it (D49): a keyed problem by its key, anything else
 * (what a script's engine said, or an error no catalog has) in the English it came in, `message`.
 */
export const errorWords = (e: unknown, message: string): ProblemSaid =>
  e instanceof AppError && e.words ? e.words : { key: 'inItsOwnWords', values: { words: asSentence(message) } };

/**
 * One of the words a server writes about something it shows, beside the API's English (D49), checked
 * as a keyed problem's are: under tests, the catalog's English must say what `message` says.
 */
export function noted(message: string, key: string, values?: Record<string, string | number | ListSaid>): { message: string; words: ProblemSaid } {
  checkProblemWords(message, undefined, values ? { key, values } : { key });
  return { message, words: values ? { key, values } : { key } };
}

import { keyedProblem } from '../lib/errors';
export type TokenKind = 'word' | 'quoted' | 'braced' | 'hash' | 'colon' | 'comma' | 'lparen' | 'rparen' | 'minus' | 'dotdot';

export interface Token {
  kind: TokenKind;
  /** Raw text for words; inner text for quoted/braced/hash. */
  value: string;
  start: number;
  end: number;
}

export interface LexProblem {
  message: string;
  start: number;
  end: number;
  /** Its words for a page in another language (D49). */
  key?: string;
  values?: Record<string, string | number>;
}

const WORD_STOP = new Set([' ', '\t', '\n', '\r', ':', ',', '(', ')', '"', '{', '}', '#']);

/** A value as it must be typed to read as one value: braced when it has a space or a stop. */
export function quoteValue(value: string): string {
  if (![...value].some((ch) => WORD_STOP.has(ch))) return value;
  return value.includes('}') ? `"${value.replace(/"/g, '')}"` : `{${value}}`;
}

/** The text with every problem's fix applied, when each one has a fix; otherwise null. */
export function withFixes(input: string, problems: { start: number; end: number; fix?: string }[]): string | null {
  if (!problems.length || problems.some((p) => p.fix === undefined)) return null;
  let out = input;
  for (const p of [...problems].sort((a, b) => b.start - a.start)) out = out.slice(0, p.start) + p.fix + out.slice(p.end);
  return out;
}

/**
 * What to type in place of input[start..end) to take a suggested value: the value,
 * quoted as needed, after the minus or # the person typed before it.
 */
export function fixValue(input: string, start: number, end: number, value: string): string {
  const typed = input.slice(start, end);
  const before = /^-?\s*#?/.exec(typed)?.[0] ?? '';
  return before + quoteValue(value);
}

/**
 * Tokenize a query or command. Never throws: unterminated quotes/braces are
 * reported as problems and closed at end of input.
 */
export function lex(input: string): { tokens: Token[]; problems: LexProblem[] } {
  const tokens: Token[] = [];
  const problems: LexProblem[] = [];
  let i = 0;
  const n = input.length;

  const readDelimited = (open: number, close: string): { value: string; end: number } => {
    let j = open + 1;
    let value = '';
    while (j < n && input[j] !== close) {
      if (close === '"' && input[j] === '\\' && j + 1 < n) {
        value += input[j + 1];
        j += 2;
        continue;
      }
      value += input[j];
      j++;
    }
    if (j >= n) {
      problems.push(keyedProblem({ message: `Missing closing ${close}`, start: open, end: n }, 'query.missingClosing', { close }));
      return { value, end: n };
    }
    return { value, end: j + 1 };
  };

  while (i < n) {
    const ch = input[i]!;
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') {
      i++;
      continue;
    }
    if (ch === ':') {
      tokens.push({ kind: 'colon', value: ':', start: i, end: i + 1 });
      i++;
      continue;
    }
    if (ch === ',') {
      tokens.push({ kind: 'comma', value: ',', start: i, end: i + 1 });
      i++;
      continue;
    }
    if (ch === '(') {
      tokens.push({ kind: 'lparen', value: '(', start: i, end: i + 1 });
      i++;
      continue;
    }
    if (ch === ')') {
      tokens.push({ kind: 'rparen', value: ')', start: i, end: i + 1 });
      i++;
      continue;
    }
    if (ch === '"') {
      const { value, end } = readDelimited(i, '"');
      tokens.push({ kind: 'quoted', value, start: i, end });
      i = end;
      continue;
    }
    if (ch === '{') {
      const { value, end } = readDelimited(i, '}');
      tokens.push({ kind: 'braced', value: value.trim(), start: i, end });
      i = end;
      continue;
    }
    if (ch === '}') {
      problems.push(keyedProblem({ message: 'Unexpected }', start: i, end: i + 1 }, 'query.unexpectedBrace'));
      i++;
      continue;
    }
    if (ch === '#') {
      const next = input[i + 1];
      if (next === '{' || next === '"') {
        const { value, end } = readDelimited(i + 1, next === '{' ? '}' : '"');
        tokens.push({ kind: 'hash', value: value.trim(), start: i, end });
        i = end;
        continue;
      }
      let j = i + 1;
      while (j < n && !WORD_STOP.has(input[j]!)) j++;
      tokens.push({ kind: 'hash', value: input.slice(i + 1, j), start: i, end: j });
      i = j;
      continue;
    }
    if (ch === '.' && input[i + 1] === '.') {
      tokens.push({ kind: 'dotdot', value: '..', start: i, end: i + 2 });
      i += 2;
      continue;
    }
    if (ch === '-' && i + 1 < n && !WORD_STOP.has(input[i + 1]!) && (i === 0 || WORD_STOP.has(input[i - 1]!) || input[i - 1] === '-')) {
      tokens.push({ kind: 'minus', value: '-', start: i, end: i + 1 });
      i++;
      continue;
    }
    // word: stop at delimiters and at ".."
    let j = i;
    while (j < n && !WORD_STOP.has(input[j]!) && !(input[j] === '.' && input[j + 1] === '.')) j++;
    if (j === i) j = i + 1;
    tokens.push({ kind: 'word', value: input.slice(i, j), start: i, end: j });
    i = j;
  }
  return { tokens, problems };
}

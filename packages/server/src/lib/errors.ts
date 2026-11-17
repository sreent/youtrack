/** What a problem says in any language: its key under problem.* in the catalogs, and the values it takes (D49). */
export type ProblemWords = { key: string; values?: Record<string, string | number> };

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
  said(key: string, values?: Record<string, string | number>): this {
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
export const aiDisabled = () =>
  new AppError(
    503,
    'ai_disabled',
    'AI features are not configured on this server',
    'Set ANTHROPIC_API_KEY in the server environment and restart.',
  ).said('aiDisabled');

/**
 * Words of a problem's own that someone wrote (a script's refusal, a rule's message), ended as a
 * page's sentence ends them: the value a keyed problem places where the API puts them whole (D49).
 */
export const asSentence = (words: string): string => (/[.!?…:]["”’)]*$/.test(words.trim()) ? words.trim() : `${words.trim()}.`);

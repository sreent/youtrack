export class AppError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly hint?: string,
    public readonly details?: unknown,
  ) {
    super(message);
  }
}

export const badRequest = (message: string, hint?: string, details?: unknown) =>
  new AppError(400, 'bad_request', message, hint, details);
export const unauthorized = (message = 'Authentication required', hint?: string) =>
  new AppError(401, 'unauthorized', message, hint);
export const forbidden = (message = 'You do not have permission to do this', hint?: string) =>
  new AppError(403, 'forbidden', message, hint);
export const notFound = (what: string, hint?: string) => new AppError(404, 'not_found', `${what} not found`, hint);
export const conflict = (message: string, hint?: string, details?: unknown) =>
  new AppError(409, 'conflict', message, hint, details);
export const aiDisabled = () =>
  new AppError(
    503,
    'ai_disabled',
    'AI features are not configured on this server',
    'Set ANTHROPIC_API_KEY in the server environment and restart.',
  );

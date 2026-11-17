import type { QueryProblem } from '@a4a/shared';
import { getLocale, t as tx } from '../i18n';

const BASE = '/api/v1';

/** An error from the API, with the server's hint on how to fix it. */
export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly hint?: string,
    public readonly details?: unknown,
    /** The problem's key under problem.* and its values, when the server gave them (D49). */
    public readonly key?: string,
    public readonly values?: Record<string, string | number>,
  ) {
    super(message);
  }

  /** Query or command problems, when the server sent them. */
  get problems(): QueryProblem[] {
    const d = this.details as { problems?: QueryProblem[] } | undefined;
    return d?.problems ?? [];
  }
}

async function toError(res: Response): Promise<ApiError> {
  try {
    const body = (await res.json()) as { error?: { code: string; message: string; hint?: string; details?: unknown; key?: string; values?: Record<string, string | number> } };
    if (body.error) return new ApiError(res.status, body.error.code, body.error.message, body.error.hint, body.error.details, body.error.key, body.error.values);
  } catch {
    // not JSON
  }
  return new ApiError(res.status, 'http_error', res.statusText || tx('api.client.requestFailed', { status: res.status }));
}

export interface RequestOptions {
  signal?: AbortSignal;
  idempotencyKey?: string;
  /** More headers, such as a help desk request's tracking token. */
  headers?: Record<string, string>;
}

export async function api<T>(method: string, path: string, body?: unknown, opts: RequestOptions = {}): Promise<T> {
  // The page's language, for the words the server says to its person (D49).
  const headers: Record<string, string> = { accept: 'application/json', 'x-a4a-locale': getLocale(), ...opts.headers };
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (opts.idempotencyKey) headers['idempotency-key'] = opts.idempotencyKey;
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    credentials: 'same-origin',
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal: opts.signal,
  });
  if (!res.ok) throw await toError(res);
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

export const get = <T>(path: string, opts?: RequestOptions) => api<T>('GET', path, undefined, opts);
export const post = <T>(path: string, body?: unknown, opts?: RequestOptions) => api<T>('POST', path, body ?? {}, opts);
export const patch = <T>(path: string, body: unknown) => api<T>('PATCH', path, body);
export const put = <T>(path: string, body: unknown) => api<T>('PUT', path, body);
export const del = (path: string) => api<void>('DELETE', path);

export function qs(params: Record<string, string | number | boolean | undefined | null>): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') p.set(k, String(v));
  const s = p.toString();
  return s ? `?${s}` : '';
}

/**
 * POST and read the response as Server-Sent Events (the assistant streams this
 * way; EventSource can't POST). Resolves when the stream ends.
 */
export async function postStream<E>(path: string, body: unknown, onEvent: (event: E) => void, signal?: AbortSignal): Promise<void> {
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
    credentials: 'same-origin',
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok || !res.body) throw await toError(res);
  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += value;
    let sep: number;
    while ((sep = buffer.indexOf('\n\n')) >= 0) {
      const frame = buffer.slice(0, sep);
      buffer = buffer.slice(sep + 2);
      const data = frame
        .split('\n')
        .filter((l) => l.startsWith('data:'))
        .map((l) => l.slice(5).trimStart())
        .join('\n');
      if (data) onEvent(JSON.parse(data) as E);
    }
  }
}

/**
 * Your unread count, live: on connecting, and whenever your inbox changes. It carries a count, not
 * events, so a reconnect to any instance just starts again with the count as it is.
 */
export function subscribeInbox(onUnread: (unread: number) => void): () => void {
  let source: EventSource | null = null;
  let closed = false;
  let retry = 1000;
  const open = () => {
    if (closed) return;
    source = new EventSource(`${BASE}/notifications/stream`, { withCredentials: true });
    source.addEventListener('unread', (e) => {
      retry = 1000;
      onUnread((JSON.parse((e as MessageEvent).data) as { unread: number }).unread);
    });
    source.onerror = () => {
      source?.close();
      setTimeout(open, (retry = Math.min(retry * 2, 30_000)));
    };
  };
  open();
  return () => {
    closed = true;
    source?.close();
  };
}

/**
 * Live tracker events. A reconnect, to whichever server instance, resumes after the
 * last event seen, so nothing is missed; when too much was, `resync` arrives instead.
 */
export function subscribeEvents(onEvent: (event: { type: string; issue: { id: string } | null; project: string | null }) => void): () => void {
  let source: EventSource | null = null;
  let closed = false;
  let retry = 1000;
  let lastId = '';
  const open = () => {
    if (closed) return;
    source = new EventSource(`${BASE}/events/stream${lastId ? `?after=${encodeURIComponent(lastId)}` : ''}`, { withCredentials: true });
    source.onmessage = () => {};
    source.addEventListener('ready', () => {
      retry = 1000;
    });
    const seen = (e: Event) => {
      lastId = (e as MessageEvent).lastEventId || lastId;
    };
    source.addEventListener('resync', (e) => {
      seen(e);
      onEvent({ type: 'resync', issue: null, project: null });
    });
    const types = ['issue.created', 'issue.updated', 'issue.deleted', 'comment.created', 'comment.updated', 'comment.deleted', 'link.created', 'link.deleted', 'work.logged', 'work.deleted', 'ai.triage.completed', 'baseline.created', 'attachment.added', 'attachment.removed', 'article.created', 'article.updated', 'article.deleted', 'sprint.issue_added', 'sprint.issue_removed', 'commit.linked', 'pull_request.linked', 'pull_request.updated', 'board.issue_ranked'];
    for (const t of types)
      source.addEventListener(t, (e) => {
        seen(e);
        onEvent(JSON.parse((e as MessageEvent).data));
      });
    source.onerror = () => {
      source?.close();
      setTimeout(open, (retry = Math.min(retry * 2, 30_000)));
    };
  };
  open();
  return () => {
    closed = true;
    source?.close();
  };
}

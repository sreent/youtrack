import type { TrackerEvent } from '@a4a/shared';

export interface Frame {
  event: string;
  id?: string;
  data: string;
}

export interface SseClient {
  headers: Headers;
  frames: Frame[];
  /** Tracker events received so far (not `ready`, `resync` or comments). */
  events(): TrackerEvent[];
  /** Resolve with the first frame (already received or to come) that matches. */
  waitFor(match: (f: Frame) => boolean, timeoutMs?: number): Promise<Frame>;
  /** Resolve once `n` tracker events have arrived. */
  waitForEvents(n: number, timeoutMs?: number): Promise<TrackerEvent[]>;
  /** The id a browser would send back as Last-Event-ID. */
  lastEventId(): string | undefined;
  close(): Promise<void>;
  closed: Promise<void>;
}

type Fetcher = (path: string, init: RequestInit) => Response | Promise<Response>;

/** Open GET /api/v1/events/stream on an app (Hono's `request`) and parse frames as they arrive. */
export async function openStream(request: Fetcher, token: string, opts: { query?: string; lastEventId?: string } = {}): Promise<SseClient> {
  const headers: Record<string, string> = { authorization: `Bearer ${token}`, accept: 'text/event-stream' };
  if (opts.lastEventId) headers['last-event-id'] = opts.lastEventId;
  const res = await request(`/api/v1/events/stream${opts.query ?? ''}`, { headers });
  if (res.status !== 200 || !res.body) throw new Error(`stream answered ${res.status}: ${await res.text()}`);
  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  const frames: Frame[] = [];
  const waiters = new Set<() => void>();
  let buffer = '';
  const closed = (async () => {
    for (;;) {
      let chunk: { done: boolean; value?: string };
      try {
        chunk = await reader.read();
      } catch {
        break;
      }
      if (chunk.done) break;
      buffer += chunk.value;
      let sep: number;
      while ((sep = buffer.indexOf('\n\n')) >= 0) {
        const raw = buffer.slice(0, sep);
        buffer = buffer.slice(sep + 2);
        const frame: Frame = { event: 'message', data: '' };
        const data: string[] = [];
        for (const line of raw.split('\n')) {
          if (line.startsWith(':')) continue;
          const colon = line.indexOf(':');
          const field = colon < 0 ? line : line.slice(0, colon);
          const value = colon < 0 ? '' : line.slice(colon + 1).replace(/^ /, '');
          if (field === 'event') frame.event = value;
          else if (field === 'id') frame.id = value;
          else if (field === 'data') data.push(value);
        }
        if (!data.length && frame.id === undefined) continue; // a comment (keep-alive)
        frame.data = data.join('\n');
        frames.push(frame);
      }
      for (const w of [...waiters]) w();
    }
    for (const w of [...waiters]) w();
  })();
  let ended = false;
  void closed.then(() => {
    ended = true;
  });
  const isEvent = (f: Frame) => f.event !== 'ready' && f.event !== 'resync' && f.event !== 'message';
  const client: SseClient = {
    headers: res.headers,
    frames,
    closed,
    events: () => frames.filter(isEvent).map((f) => JSON.parse(f.data) as TrackerEvent),
    lastEventId: () => [...frames].reverse().find((f) => f.id !== undefined)?.id,
    waitFor: (match, timeoutMs = 5_000) =>
      new Promise<Frame>((resolve, reject) => {
        const check = () => {
          const hit = frames.find(match);
          if (hit) {
            waiters.delete(check);
            clearTimeout(timer);
            resolve(hit);
          } else if (ended) {
            waiters.delete(check);
            clearTimeout(timer);
            reject(new Error(`the stream ended first; frames: ${JSON.stringify(frames.map((f) => f.event))}`));
          }
        };
        const timer = setTimeout(() => {
          waiters.delete(check);
          reject(new Error(`no matching frame within ${timeoutMs} ms; frames: ${JSON.stringify(frames.map((f) => `${f.event}#${f.id ?? ''}`))}`));
        }, timeoutMs);
        waiters.add(check);
        check();
      }),
    waitForEvents: async (n, timeoutMs = 5_000) => {
      await client.waitFor(() => client.events().length >= n, timeoutMs);
      return client.events();
    },
    close: async () => {
      await reader.cancel().catch(() => {});
      await closed;
    },
  };
  return client;
}

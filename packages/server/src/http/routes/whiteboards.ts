/**
 * Whiteboards (D58): the whiteboards of the projects you read, their elements in batches, their cards
 * as you may see them, converting notes and arrows, who's looking, and each whiteboard's live stream.
 */
import type { OpenAPIHono } from '@hono/zod-openapi';
import {
  WhiteboardBatchBody,
  WhiteboardBatchResultSchema,
  WhiteboardCardSchema,
  WhiteboardConvertBody,
  WhiteboardConvertResultSchema,
  WhiteboardCreateBody,
  WhiteboardDetailSchema,
  WhiteboardRenameBody,
  WhiteboardSchema,
  WhiteboardShareBody,
  WhiteboardViewerSchema,
  WHITEBOARD_LIMITS,
  type WhiteboardChangeFrame,
  type WhiteboardElement,
} from '@a4a/shared';
import { eq } from 'drizzle-orm';
import { streamSSE } from 'hono/streaming';
import { z } from 'zod';
import { whiteboards } from '../../db/schema';
import { whiteboardLive, type WhiteboardChangeRow, type WhiteboardSignal } from '../../events/whiteboard-live';
import { AppError } from '../../lib/errors';
import { newId } from '../../lib/ids';
import { projectAccess } from '../../services/access';
import { userRefDto } from '../../services/values';
import {
  applyWhiteboardBatch,
  convertWhiteboard,
  createWhiteboard,
  deleteWhiteboard,
  getWhiteboard,
  getWhiteboardCards,
  listViewers,
  listWhiteboards,
  lookAt,
  markViewing,
  personalAccess,
  renameWhiteboard,
  requireWhiteboard,
  seesViewers,
  setWhiteboardSharing,
  stopViewing,
  viewersOf,
} from '../../services/whiteboards';
import type { HttpEnv } from '../env';
import { clientIp } from '../middleware';
import { route } from '../route';
import { uploadRoute } from './attachments';

const Id = z.object({ id: z.string().min(1).max(40) });
/** Signals waiting for a slow client before its stream is closed (it reconnects and resumes). */
const MAX_QUEUE = 2_000;

/**
 * Guests' open streams, on this instance (D64). A stream is one request however long it stays open, so
 * the guest rate limit alone would let one address hold hundreds, each read again on every change; and
 * guests are nobody in particular. So each address holds a few, and all guests together a few hundred:
 * past either, a guest is told to close one, and the team's streams are never what runs out.
 */
export const GUEST_STREAM_LIMITS = { perAddress: 4, total: 400 };
const guestStreams = new Map<string, number>();
let guestStreamsOpen = 0;

function openGuestStream(address: string): () => void {
  const mine = guestStreams.get(address) ?? 0;
  if (mine >= GUEST_STREAM_LIMITS.perAddress || guestStreamsOpen >= GUEST_STREAM_LIMITS.total) {
    throw new AppError(429, 'rate_limited', 'Too many whiteboards are open live without signing in', 'Close one of them, or sign in, then open this one again.').said('whiteboards.guestStreams');
  }
  guestStreams.set(address, mine + 1);
  guestStreamsOpen++;
  let closed = false;
  return () => {
    if (closed) return;
    closed = true;
    guestStreamsOpen--;
    const left = (guestStreams.get(address) ?? 1) - 1;
    if (left > 0) guestStreams.set(address, left);
    else guestStreams.delete(address);
  };
}

export function whiteboardRoutes(app: OpenAPIHono<HttpEnv>) {
  const tags = ['Whiteboards'];
  route(
    app,
    {
      method: 'get',
      path: '/whiteboards', guests: true,
      tags,
      summary: 'Whiteboards you can see',
      description: 'The whiteboards of every project you read, or of one, and your own and those shared with you, the latest changed first.',
      query: z.object({ project: z.string().max(40).optional().describe('A project’s key') }),
      response: z.array(WhiteboardSchema),
    },
    ({ ctx, query }) => listWhiteboards(ctx, { project: query.project }),
  );
  route(
    app,
    {
      method: 'post',
      path: '/whiteboards',
      tags,
      summary: 'Make a whiteboard',
      description: 'In a project where you may change issues, or, without a project, a whiteboard of your own: shared with everyone signed in, or limited to the people and groups you name.',
      body: WhiteboardCreateBody,
      response: WhiteboardSchema,
    },
    ({ ctx, body }) => createWhiteboard(ctx, body),
  );
  route(
    app,
    {
      method: 'get',
      path: '/whiteboards/{id}', guests: true,
      tags,
      summary: 'A whiteboard, whole',
      description:
        'Its elements, its cards as you may see them (an issue or article you may not see is `shown: false` and nothing more), and who is looking. One in a project you can’t read is not found, as one that doesn’t exist.',
      params: Id,
      response: WhiteboardDetailSchema,
    },
    ({ ctx, params }) => getWhiteboard(ctx, params.id),
  );
  route(
    app,
    { method: 'patch', path: '/whiteboards/{id}', tags, summary: 'Rename a whiteboard', params: Id, body: WhiteboardRenameBody, response: WhiteboardSchema },
    ({ ctx, params, body }) => renameWhiteboard(ctx, params.id, body),
  );
  route(
    app,
    {
      method: 'patch',
      path: '/whiteboards/{id}/sharing',
      tags,
      summary: 'Say who else reads a personal whiteboard',
      description: 'Its owner’s alone: everyone signed in, or the people and groups named. A project’s whiteboard follows its project.',
      params: Id,
      body: WhiteboardShareBody,
      response: WhiteboardSchema,
    },
    ({ ctx, params, body }) => setWhiteboardSharing(ctx, params.id, body),
  );
  route(
    app,
    {
      method: 'delete',
      path: '/whiteboards/{id}',
      tags,
      summary: 'Delete a whiteboard',
      description: 'Whoever made it, or a manager of its project. Its elements go with it; the issues and articles on its cards stay as they are.',
      params: Id,
      status: 204,
    },
    ({ ctx, params }) => deleteWhiteboard(ctx, params.id),
  );
  route(
    app,
    {
      method: 'post',
      path: '/whiteboards/{id}/elements',
      tags,
      summary: 'Change a whiteboard’s elements',
      description: `A batch of operations, applied in order in one transaction: \`add\` (an id you choose, its kind and place; a card names its issue or article, an arrow its two ends), \`update\` (\`set\` only what changes) and \`remove\` (an arrow goes with what it joins). Place, size and stacking go to the last writer, property by property, so two people's changes to different properties, or different elements, both land. \`expect\` makes an operation conditional on values the element still has: if someone changed them, that operation alone is refused with the element as it is now, and the rest go on. At most ${WHITEBOARD_LIMITS.elements} elements on a whiteboard and ${WHITEBOARD_LIMITS.text} characters of text in one.`,
      params: Id,
      body: WhiteboardBatchBody,
      response: WhiteboardBatchResultSchema,
      status: 200,
    },
    ({ ctx, params, body }) => applyWhiteboardBatch(ctx, params.id, body),
  );
  // A picture on the whiteboard (D58's revisit): uploaded as every file is, then added by its id.
  uploadRoute(app, '/whiteboards/{id}/attachments', 'A picture for a whiteboard', 'Uploaded as every file is, in a part named `file`; the batch that adds it names its attachment. Whoever may change the whiteboard may put a picture there; whoever reads it sees the picture. Deleting the whiteboard takes its pictures with it.', async (ctx, id) => {
    const board = await requireWhiteboard(ctx, id, 'edit');
    return { kind: 'whiteboard', whiteboard: { id: board.id, projectId: board.projectId, name: board.name } };
  });

  route(
    app,
    {
      method: 'get',
      path: '/whiteboards/{id}/cards', guests: true,
      tags,
      summary: 'What a whiteboard’s cards hold',
      description: 'Each issue card’s id, summary, state and assignee, and each article card’s id and title, as you may see them now; what you may not see is `shown: false`, the same for every reason.',
      params: Id,
      response: z.array(WhiteboardCardSchema),
    },
    ({ ctx, params }) => getWhiteboardCards(ctx, params.id),
  );
  route(
    app,
    {
      method: 'post',
      path: '/whiteboards/{id}/convert',
      tags,
      summary: 'Make issues of notes, and links of arrows',
      description: `Each note becomes an issue in \`project\` (its first line the summary, the rest the description), and its card the issue's, where it was. Each arrow whose ends are issues, or become issues here, becomes a link of the type named, never twice. Each is done on its own: one that fails says why, and the others still convert. Up to ${WHITEBOARD_LIMITS.convert} of each. \`dryRun\` says what would happen and changes nothing.`,
      params: Id,
      body: WhiteboardConvertBody,
      response: WhiteboardConvertResultSchema,
      status: 200,
    },
    ({ ctx, params, body }) => convertWhiteboard(ctx, params.id, body),
  );
  route(
    app,
    { method: 'get', path: '/whiteboards/{id}/presence', tags, summary: 'Who is looking at a whiteboard', params: Id, response: z.array(WhiteboardViewerSchema) },
    ({ ctx, params }) => listViewers(ctx, params.id),
  );
  route(
    app,
    {
      method: 'put',
      path: '/whiteboards/{id}/presence',
      tags,
      summary: 'Say you are looking at a whiteboard',
      description: 'For 45 seconds, or until you say it again: for a client without the live stream, which says it for as long as it is open.',
      params: Id,
      response: z.array(WhiteboardViewerSchema),
    },
    ({ ctx, params }) => lookAt(ctx, params.id),
  );

  route(
    app,
    {
      method: 'get',
      path: '/whiteboards/{id}/stream', guests: true,
      tags,
      summary: 'A whiteboard, live, over Server-Sent Events',
      description:
        'Each change to its elements (`change`, with its `seq` as the event id: the elements as they are after it, and what it removed), who is looking (`viewers`), a new name (`renamed`), and `gone` when it is deleted or you may no longer see it. You are among its viewers while the stream is open. On reconnect, send the last id back as `Last-Event-ID` (browsers do) or `after`: what you missed is replayed, or, if more than 500 changes ago, `resync` says to read it again.',
      params: Id,
      query: z.object({ after: z.coerce.number().int().min(0).optional() }),
    },
    async ({ c, ctx, params, query }) => {
      const board = await requireWhiteboard(ctx, params.id);
      // A guest's stream carries the changes, never who's looking, nor counts them among it (D64).
      const people = seesViewers(ctx);
      const release = people ? () => {} : openGuestStream(clientIp(c, ctx.app.config.trustProxy));
      const hub = whiteboardLive(ctx.app);
      const header = c.req.header('last-event-id')?.trim();
      const resume = header && /^\d+$/.test(header) ? Number(header) : (query.after ?? null);
      const session = newId();
      c.header('x-accel-buffering', 'no');
      return streamSSE(c, async (stream) => {
        try {
          await live(stream);
        } finally {
          release();
        }
      });

      async function live(stream: Parameters<Parameters<typeof streamSSE>[1]>[0]): Promise<void> {
        const queue: WhiteboardSignal[] = [];
        let wake: (() => void) | null = null;
        const { position, unsubscribe } = await hub.subscribe(board.id, (signal) => {
          if (queue.length >= MAX_QUEUE) stream.abort();
          else queue.push(signal);
          wake?.();
        });
        stream.onAbort(() => {
          unsubscribe();
          wake?.();
        });
        const s = () => ctx.app.schema.get();
        const frame = async (row: WhiteboardChangeRow): Promise<WhiteboardChangeFrame> => {
          const by = row.actorId ? (await s()).users.get(row.actorId) : undefined;
          return { seq: Number(row.seq), by: by ? userRefDto(by) : null, client: row.client, elements: row.elements as WhiteboardElement[], removed: row.removed };
        };
        // Whether they may still see it, as access stands now (two seconds old at most): someone taken off its project stops hearing.
        const current = async () => {
          const [row] = await ctx.db.select().from(whiteboards).where(eq(whiteboards.id, board.id));
          if (!row) return null;
          const view = await projectAccess(ctx);
          return row.projectId ? (view.canRead(row.projectId) ? row : null) : personalAccess(view, row).read ? row : null;
        };
        let name = board.name;
        let viewers = '';
        const sayViewers = async () => {
          if (!people) return;
          const now = JSON.stringify(await viewersOf(ctx.db, await s(), board.id));
          if (now !== viewers) await stream.writeSSE({ event: 'viewers', data: (viewers = now) });
        };
        try {
          if (people) await markViewing(ctx, board.id, session);
          await stream.writeSSE({ event: 'ready', id: String(Math.max(position, resume ?? 0)), data: JSON.stringify({ seq: position }) });
          let sent = position;
          if (resume !== null && resume < position) {
            const missed = await hub.replay(board.id, resume, position);
            if (!missed) await stream.writeSSE({ event: 'resync', id: String(position), data: JSON.stringify({ seq: position }) });
            else for (const row of missed) await stream.writeSSE({ event: 'change', id: String(row.seq), data: JSON.stringify(await frame(row)) });
          } else if (resume !== null && resume > position) sent = resume;
          await sayViewers();
          let beat = Date.now();
          while (!stream.aborted && !stream.closed) {
            while (queue.length && !stream.aborted) {
              const signal = queue.shift()!;
              if (signal.kind === 'change' && signal.row.seq <= sent) continue;
              const now = await current();
              if (!now) {
                await stream.writeSSE({ event: 'gone', data: JSON.stringify({ id: board.id }) });
                stream.abort();
                break;
              }
              if (signal.kind === 'change') {
                sent = Number(signal.row.seq);
                await stream.writeSSE({ event: 'change', id: String(sent), data: JSON.stringify(await frame(signal.row)) });
              } else if (signal.kind === 'resync') {
                await stream.writeSSE({ event: 'resync', id: String(Number(now.seq)), data: JSON.stringify({ seq: Number(now.seq) }) });
                sent = Math.max(sent, Number(now.seq));
              } else {
                if (now.name !== name) await stream.writeSSE({ event: 'renamed', data: JSON.stringify({ name: (name = now.name) }) });
                await sayViewers();
              }
            }
            if (stream.aborted) break;
            if (Date.now() - beat >= 15_000) {
              if (people) await markViewing(ctx, board.id, session);
              beat = Date.now();
            }
            await new Promise<void>((resolve) => {
              wake = resolve;
              setTimeout(resolve, 15_000).unref?.();
            });
            wake = null;
            if (!queue.length && !stream.aborted) await stream.write(': keep-alive\n\n');
          }
        } finally {
          unsubscribe();
          if (people) await stopViewing(ctx, board.id, session).catch(() => {});
        }
      }
    },
  );
}

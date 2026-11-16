import type { OpenAPIHono } from '@hono/zod-openapi';
import {
  MarkReadBody,
  MarkReadResultSchema,
  NotificationListQuery,
  NotificationListSchema,
  NotificationSchema,
  NotificationSettingsBody,
  NotificationSettingsSchema,
  UnsubscribeQuery,
  UnsubscribeSchema,
  WatchersSchema,
} from '@a4a/shared';
import { streamSSE } from 'hono/streaming';
import { z } from 'zod';
import { EVERYONE, onInboxChanged, onInboxStreamsEnd } from '../../notify/state';
import {
  applyUnsubscribe,
  describeUnsubscribe,
  getNotification,
  getNotificationSettings,
  listNotifications,
  markNotifications,
  unreadCount,
  updateNotificationSettings,
} from '../../services/notifications';
import { listWatchers, unwatchIssue, watchIssue } from '../../services/watchers';
import type { HttpEnv } from '../env';
import { route } from '../route';

const Id = z.object({ id: z.string().describe('Readable id (BACK-12) or internal id') });

export function notificationRoutes(app: OpenAPIHono<HttpEnv>) {
  const watch = ['Watchers'];
  route(app, { method: 'get', path: '/issues/{id}/watchers', tags: watch, summary: 'Who watches an issue, and why; and whether you do', params: Id, response: WatchersSchema }, ({ ctx, params }) => listWatchers(ctx, params.id));
  route(
    app,
    {
      method: 'put',
      path: '/issues/{id}/watchers/me',
      tags: watch,
      summary: 'Watch an issue',
      description: 'You are told about its changes and comments, in a4a and by email if you want. Watching it already changes nothing. People also watch what they report, are assigned, comment on or are mentioned in.',
      params: Id,
      response: WatchersSchema,
    },
    ({ ctx, params }) => watchIssue(ctx, params.id),
  );
  route(
    app,
    {
      method: 'delete',
      path: '/issues/{id}/watchers/me',
      tags: watch,
      summary: 'Stop watching an issue',
      description: 'Until you take part in it again: commenting, being assigned or mentioned watches it again. Mentions and assignments are told to you either way.',
      params: Id,
      response: WatchersSchema,
    },
    ({ ctx, params }) => unwatchIssue(ctx, params.id),
  );

  const tags = ['Notifications'];
  route(
    app,
    {
      method: 'get',
      path: '/notifications',
      tags,
      summary: 'Your notifications, latest first',
      description: 'Changes to one issue that came close together are one notification, with each event in `events`. Group them by `issue` for an inbox by issue.',
      query: NotificationListQuery,
      response: NotificationListSchema,
    },
    ({ ctx, query }) => listNotifications(ctx, { unread: query.unread === 'true', issue: query.issue, offset: query.offset, limit: query.limit }),
  );
  route(app, { method: 'get', path: '/notifications/count', tags, summary: 'How many of your notifications are unread', response: z.object({ unread: z.number().int() }) }, async ({ ctx }) => ({ unread: await unreadCount(ctx) }));
  route(
    app,
    {
      method: 'post',
      path: '/notifications/read',
      tags,
      summary: 'Mark notifications read, or unread again',
      description: 'By `ids`, by `issue`, or `all`. Send `until` (the latest `lastAt` you saw) so that what arrived after you looked stays unread.',
      body: MarkReadBody,
      response: MarkReadResultSchema,
      status: 200,
    },
    ({ ctx, body }) => markNotifications(ctx, body),
  );
  route(
    app,
    {
      method: 'patch',
      path: '/notifications/{id}',
      tags,
      summary: 'Mark one notification read or unread',
      params: z.object({ id: z.string() }),
      body: z.object({ read: z.boolean() }),
      response: NotificationSchema,
    },
    async ({ ctx, params, body }) => {
      await getNotification(ctx, params.id);
      await markNotifications(ctx, { ids: [params.id], read: body.read });
      return getNotification(ctx, params.id);
    },
  );
  route(
    app,
    {
      method: 'get',
      path: '/notifications/stream',
      tags,
      summary: 'Your unread count, live, over Server-Sent Events',
      description:
        'An `unread` event with `{unread}` on connecting and whenever it changes. Re-read GET /notifications when it does. It carries a count, not events: a reconnect, to any instance, starts again with the count as it is.',
    },
    async ({ c, ctx }) => {
      const first = await unreadCount(ctx);
      const userId = ctx.actor.user.id;
      return streamSSE(c, async (stream) => {
        let last = first;
        let dirty = false;
        let ended = false;
        let wake: (() => void) | null = null;
        // Changes on this instance, and on others by NOTIFY (EVERYONE after signals may have been missed).
        const off = onInboxChanged(ctx.app, (id) => {
          if (id !== userId && id !== EVERYONE) return;
          if (id === userId) dirty = true;
          wake?.();
        });
        const offEnd = onInboxStreamsEnd(ctx.app, () => {
          ended = true;
          wake?.();
        });
        stream.onAbort(() => {
          off();
          offEnd();
          wake?.();
        });
        await stream.writeSSE({ event: 'unread', data: JSON.stringify({ unread: first }) });
        while (!stream.aborted && !stream.closed && !ended) {
          await new Promise<void>((resolve) => {
            wake = resolve;
            // A backstop for a NOTIFY that was lost: count again now and then.
            setTimeout(resolve, 15_000).unref?.();
          });
          wake = null;
          if (stream.aborted || ended) break;
          const now = await unreadCount(ctx).catch(() => last);
          // A change folded into a notification leaves the count as it was, but the inbox isn't.
          if (dirty || now !== last) {
            dirty = false;
            last = now;
            await stream.writeSSE({ event: 'unread', data: JSON.stringify({ unread: now }) });
          } else {
            await stream.write(': keep-alive\n\n');
          }
        }
        off();
        offEnd();
      });
    },
  );

  route(app, { method: 'get', path: '/me/notification-settings', tags, summary: 'What a4a emails you', response: NotificationSettingsSchema }, ({ ctx }) => getNotificationSettings(ctx));
  route(
    app,
    {
      method: 'patch',
      path: '/me/notification-settings',
      tags,
      summary: 'Choose what a4a emails you',
      description: '`email`: `all` (every notification), `direct` (mentions, assignments, new help desk requests) or `none`; `digest`: a daily email of what is still unread. Notifications in a4a are always on.',
      body: NotificationSettingsBody,
      response: NotificationSettingsSchema,
    },
    ({ ctx, body }) => updateNotificationSettings(ctx, body),
  );

  // One-click unsubscribe (RFC 8058). No sign-in: the signed token is the authority, and it only stops email.
  const unsub = ['Unsubscribe'];
  route(
    app,
    { method: 'get', path: '/unsubscribe', tags: unsub, summary: "What an email's unsubscribe link stops, without stopping it", auth: 'none', query: UnsubscribeQuery, response: UnsubscribeSchema },
    ({ c, query }) => describeUnsubscribe(c.get('runtime'), query.token),
  );
  route(
    app,
    {
      method: 'post',
      path: '/unsubscribe',
      tags: unsub,
      summary: 'Stop what an unsubscribe link stops',
      description: 'The link from an email\'s List-Unsubscribe header, POSTed with `List-Unsubscribe=One-Click` by a mail client, or by the page the email links to. Doing it twice is the same as once.',
      auth: 'none',
      query: UnsubscribeQuery,
      response: UnsubscribeSchema,
      status: 200,
    },
    ({ c, query }) => applyUnsubscribe(c.get('runtime'), query.token),
  );
}

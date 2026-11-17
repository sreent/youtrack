import type { OpenAPIHono } from '@hono/zod-openapi';
import {
  ChatAccountSchema,
  ChatChannelSchema,
  ChatLinkSchema,
  ChatStatusSchema,
  ChatSubscriptionSchema,
  ConnectSlackBody,
  CreateChatSubscriptionBody,
  UpdateChatSubscriptionBody,
} from '@a4a/shared';
import { bodyLimit } from 'hono/body-limit';
import { z } from 'zod';
import type { Runtime } from '../../app-services';
import { teamsAppPackage } from '../../chat/package';
import {
  acceptChatLink,
  chatLinkInfo,
  chatStatus,
  createChatSubscription,
  deleteChatSubscription,
  listChatChannels,
  listChatSubscriptions,
  myChatAccounts,
  unlinkChatAccount,
  updateChatSubscription,
} from '../../chat/service';
import { connectSlack, disconnectSlack, slackCommand, slackEvent, slackInteraction, slackLinked, verifySlackRequest } from '../../chat/slack';
import { handleTeamsActivity, teamsLinked, verifyTeamsRequest, type TeamsActivity } from '../../chat/teams';
import { requireScope } from '../../context';
import { AppError, badRequest } from '../../lib/errors';
import type { HttpEnv } from '../env';
import { errorBody } from '../middleware';
import { route } from '../route';

const tags = ['Chat'];
const Id = z.object({ id: z.string() });
const Token = z.object({ token: z.string() });
/** What Teams and Slack send is small: an activity, a form, an event. */
const MAX_BODY = 256 * 1024;

export function chatRoutes(app: OpenAPIHono<HttpEnv>) {
  route(app, { method: 'get', path: '/chat/status', tags, summary: 'Teams and Slack: what is connected, and its channels', description: 'Administrators only.', response: ChatStatusSchema }, ({ ctx }) => chatStatus(ctx));
  route(
    app,
    {
      method: 'post',
      path: '/chat/slack',
      tags,
      summary: 'Connect the Slack workspace',
      description: "With its app's bot token (xoxb-…) and signing secret, both kept sealed. One workspace per a4a. Administrators only.",
      body: ConnectSlackBody,
      response: ChatStatusSchema,
      status: 200,
    },
    ({ ctx, body }) => connectSlack(ctx, body),
  );
  route(app, { method: 'delete', path: '/chat/slack', tags, summary: 'Disconnect Slack', description: 'Its subscriptions stop, and the token and secret are forgotten.', status: 204 }, async ({ ctx }) => {
    await disconnectSlack(ctx);
    return null;
  });
  route(
    app,
    { method: 'get', path: '/chat/teams/app-package', tags, summary: 'The Teams app package', description: "A zip to upload in Teams' admin center: the manifest naming this a4a's bot, and its icons. Administrators only." },
    async ({ c, ctx }) => {
      requireScope(ctx, 'admin');
      const zip = teamsAppPackage(ctx.app);
      return c.body(new Uint8Array(zip), 200, { 'content-type': 'application/zip', 'content-disposition': 'attachment; filename="a4a-teams.zip"', 'cache-control': 'no-store' });
    },
  );
  route(app, { method: 'get', path: '/chat/channels', tags, summary: 'Channels a4a can post to', response: z.array(ChatChannelSchema) }, ({ ctx }) => listChatChannels(ctx));
  route(
    app,
    {
      method: 'get',
      path: '/chat/subscriptions',
      tags,
      summary: "Channels' subscriptions",
      description: 'Those of projects you read, and your own; all of them for an administrator. `project` narrows them to one project.',
      query: z.object({ project: z.string().optional() }),
      response: z.array(ChatSubscriptionSchema),
    },
    ({ ctx, query }) => listChatSubscriptions(ctx, query),
  );
  route(
    app,
    {
      method: 'post',
      path: '/chat/subscriptions',
      tags,
      summary: "Tell a channel of a project's or a saved search's issues",
      description:
        "As you, who vouch for the channel's people: it's told only what every reader of the project may see. A project open to its members alone takes someone who manages it.",
      body: CreateChatSubscriptionBody,
      response: ChatSubscriptionSchema,
    },
    ({ ctx, body }) => createChatSubscription(ctx, body),
  );
  route(
    app,
    { method: 'patch', path: '/chat/subscriptions/{id}', tags, summary: 'Change what a channel hears of', params: Id, body: UpdateChatSubscriptionBody, response: ChatSubscriptionSchema },
    ({ ctx, params, body }) => updateChatSubscription(ctx, params.id, body),
  );
  route(app, { method: 'delete', path: '/chat/subscriptions/{id}', tags, summary: "Stop a channel's subscription", params: Id, status: 204 }, async ({ ctx, params }) => {
    await deleteChatSubscription(ctx, params.id);
    return null;
  });
  route(app, { method: 'get', path: '/chat/accounts', tags, summary: 'Your chat accounts', response: z.array(ChatAccountSchema) }, ({ ctx }) => myChatAccounts(ctx));
  route(app, { method: 'delete', path: '/chat/accounts/{id}', tags, summary: 'Unlink a chat account of yours', params: Id, status: 204 }, async ({ ctx, params }) => {
    await unlinkChatAccount(ctx, params.id);
    return null;
  });
  route(app, { method: 'get', path: '/chat/links/{token}', tags, summary: 'What a sign-in link from the bot would link', params: Token, response: ChatLinkSchema }, ({ ctx, params }) => chatLinkInfo(ctx, params.token));
  route(
    app,
    {
      method: 'post',
      path: '/chat/links/{token}',
      tags,
      summary: 'Link the chat account a sign-in link names to you',
      description: 'A person, signed in on the web: never a token or an agent. The link works once.',
      params: Token,
      response: ChatAccountSchema,
      status: 200,
    },
    ({ ctx, params }) =>
      acceptChatLink(ctx, params.token, async (row, user) => {
        if (row.platform === 'teams') await teamsLinked(ctx.app, row.reply, user);
        else await slackLinked(ctx.app, row.externalUserId, user);
      }),
  );

  // What Teams and Slack send: checked by their own signatures, before anything in them is read.
  app.use('/chat/teams/messages', bodyLimit({ maxSize: MAX_BODY, onError: (c) => c.json(errorBody('too_large', 'The request is too large'), 413) }));
  app.use('/chat/slack/*', bodyLimit({ maxSize: MAX_BODY, onError: (c) => c.json(errorBody('too_large', 'The request is too large'), 413) }));
  route(
    app,
    { method: 'post', path: '/chat/teams/messages', tags, summary: "The Teams bot's messaging endpoint", description: "Takes Bot Framework's signed activities.", auth: 'none', status: 200, hidden: true },
    async ({ c }) => {
      const runtime: Runtime = c.get('runtime');
      const raw = await c.req.text();
      let activity: TeamsActivity;
      try {
        activity = JSON.parse(raw) as TeamsActivity;
      } catch {
        // api only: Teams' Bot Framework posts here, never a page
        throw badRequest('Not an activity');
      }
      await verifyTeamsRequest(runtime, c.req.header('authorization'), { serviceUrl: activity.serviceUrl, channelId: activity.channelId });
      const answer = await handleTeamsActivity(runtime, activity);
      return answer.body === undefined ? c.body(null, answer.status as 200) : c.json(answer.body, answer.status as 200);
    },
  );
  const fromSlack = (path: string, handle: (runtime: Runtime, ws: Awaited<ReturnType<typeof verifySlackRequest>>, raw: string) => Promise<unknown>) =>
    route(app, { method: 'post', path, tags, summary: `Slack's ${path.split('/').pop()}`, auth: 'none', status: 200, hidden: true }, async ({ c }) => {
      const runtime: Runtime = c.get('runtime');
      const raw = await c.req.text();
      const ws = await verifySlackRequest(runtime, (n) => c.req.header(n), raw);
      try {
        const out = await handle(runtime, ws, raw);
        return out === null ? c.body(null, 200) : c.json(out as object, 200);
      } catch (e) {
        if (e instanceof AppError) throw e;
        console.warn(`chat: a Slack request wasn't handled: ${e instanceof Error ? e.message : String(e)}`);
        return c.json({ response_type: 'ephemeral', text: 'Something went wrong in a4a. Try again in a moment.' }, 200);
      }
    });
  fromSlack('/chat/slack/commands', (runtime, ws, raw) => slackCommand(runtime, ws, new URLSearchParams(raw)));
  fromSlack('/chat/slack/interactions', async (runtime, ws, raw) => {
    const payload = JSON.parse(new URLSearchParams(raw).get('payload') ?? '{}') as Record<string, unknown>;
    // Slack wants its answer within three seconds: what the action does is said to the person after.
    void slackInteraction(runtime, ws, payload).catch((e: unknown) => console.warn(`chat: a Slack action wasn't done: ${e instanceof Error ? e.message : String(e)}`));
    return null;
  });
  fromSlack('/chat/slack/events', (runtime, ws, raw) => slackEvent(runtime, ws, JSON.parse(raw) as Record<string, unknown>));
}

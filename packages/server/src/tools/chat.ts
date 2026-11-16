/** Channels in Teams and Slack told of issues (D42): listing them, and subscribing one, as the person you act as. */
import { CHAT_CHANGE_KINDS, DEFAULT_CHAT_KINDS } from '@a4a/shared';
import { z } from 'zod';
import { createChatSubscription, deleteChatSubscription, listChatChannels, listChatSubscriptions } from '../chat/service';
import { defineTool, type ToolDef } from './types';

const listChatChannelsTool = defineTool({
  name: 'list_chat_channels',
  title: 'List chat channels',
  description: 'The Microsoft Teams and Slack channels a4a can post to, with their ids, for subscribe_chat_channel.',
  input: z.object({}),
  kind: 'reads',
  async run(ctx) {
    const channels = await listChatChannels(ctx);
    return { data: channels.map((c) => ({ id: c.id, chat: c.platform, workspace: c.workspace, name: c.name })), summary: `${channels.length} channel${channels.length === 1 ? '' : 's'}` };
  },
});

const listChatSubscriptionsTool = defineTool({
  name: 'list_chat_subscriptions',
  title: "List channels' subscriptions",
  description: "Which channels are told of which project's or saved search's issues, and of what. Those of projects the person you act as reads, and theirs.",
  input: z.object({ project: z.string().optional().describe('A project key, to list its alone') }),
  kind: 'reads',
  async run(ctx, input) {
    const subs = await listChatSubscriptions(ctx, input);
    return {
      data: subs.map((s) => ({ id: s.id, channel: `${s.channel.name} (${s.channel.workspace}, ${s.channel.platform})`, about: s.about, by: s.createdBy?.login ?? null, stopped: s.ended?.reason ?? null })),
      summary: `${subs.length} subscription${subs.length === 1 ? '' : 's'}`,
    };
  },
});

const subscribeChatChannelTool = defineTool({
  name: 'subscribe_chat_channel',
  title: "Tell a channel of a project's issues",
  description:
    "Tell a Teams or Slack channel (list_chat_channels) of a project's issues, or a saved search's, as the person you act as, who vouches for the channel's people. The channel hears only what every reader of the project may see. A project open to its members alone takes someone who manages it.",
  input: z.object({
    channel: z.string().describe("The channel's id"),
    project: z.string().optional().describe('A project key'),
    savedSearch: z.string().optional().describe("A saved search's name or id"),
    kinds: z.array(z.enum(CHAT_CHANGE_KINDS)).optional().describe(`What it hears of; by default ${DEFAULT_CHAT_KINDS.join(', ')}`),
  }),
  kind: 'changes',
  async preview(_ctx, input) {
    return `Tell the channel ${input.channel} of ${input.project ? `${input.project.toUpperCase()}'s issues` : `the issues in "${input.savedSearch ?? ''}"`}: ${(input.kinds ?? DEFAULT_CHAT_KINDS).join(', ')}`;
  },
  async run(ctx, input) {
    const sub = await createChatSubscription(ctx, { channel: input.channel, project: input.project, savedSearch: input.savedSearch, kinds: input.kinds ? [...input.kinds] : undefined });
    return { data: { id: sub.id, about: sub.about, channel: sub.channel.name }, summary: `${sub.channel.name}: ${sub.about}` };
  },
});

const unsubscribeChatChannelTool = defineTool({
  name: 'unsubscribe_chat_channel',
  title: "Stop a channel's subscription",
  description: "Stop telling a channel of what it was subscribed to (list_chat_subscriptions). Whoever subscribed it, the project's managers and administrators may.",
  input: z.object({ id: z.string() }),
  kind: 'changes',
  destructive: true,
  async preview(_ctx, input) {
    return `Stop the channel subscription ${input.id}`;
  },
  async run(ctx, input) {
    await deleteChatSubscription(ctx, input.id);
    return { data: { stopped: input.id }, summary: 'Stopped the channel’s subscription' };
  },
});

export const chatTools = [listChatChannelsTool, listChatSubscriptionsTool, subscribeChatChannelTool, unsubscribeChatChannelTool] as unknown as ToolDef[];

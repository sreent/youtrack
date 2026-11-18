/**
 * CCs on help desk requests (D57), for agents: the same service as the API and the request's page.
 */
import { REQUEST_CCS_MAX, RequestCcBody } from '@a4a/shared';
import { z } from 'zod';
import { requestOf } from '../services/helpdesk';
import { addCc, listCcs, removeCc } from '../services/request-ccs';
import { defineTool, type ToolDef } from './types';

const issueInput = z.string().describe('The request’s issue, by its readable id, e.g. BACK-12');

const ccLine = (c: { email: string; name: string }) => (c.name ? `${c.name} <${c.email}>` : c.email);

const listRequestCcsTool = defineTool({
  name: 'list_request_ccs',
  title: 'See who is copied on a help desk request',
  description:
    'Who is copied on a help desk request: people outside the team who get its public replies and changes of state by email, as its requester does, and may answer by email. Each says how they came to be copied (by the team, from the Cc of the requester’s email, or by the requester on the portal) and when.',
  input: z.object({ issue: issueInput }),
  kind: 'reads',
  async run(ctx, input) {
    const ccs = await listCcs(ctx, input.issue);
    return {
      data: ccs.map((c) => ({ email: c.email, name: c.name || undefined, via: c.via, by: c.addedBy?.login ?? 'the requester', at: c.addedAt })),
      summary: ccs.length ? `${ccs.length} copied on ${input.issue.toUpperCase()}` : `Nobody is copied on ${input.issue.toUpperCase()}`,
    };
  },
});

const addRequestCcTool = defineTool({
  name: 'add_request_cc',
  title: 'Copy someone on a help desk request',
  description: `Copy someone outside the team on a help desk request (get_issue shows "request"): from now on they get every public reply and change of state its requester gets, by email, and may answer by email as themselves. Never internal comments. At most ${REQUEST_CCS_MAX} at once; not a4a’s own addresses, the team’s (they watch instead), or the requester’s. Ask the person first: it sends this address the team’s replies.`,
  input: z.object({ issue: issueInput, email: RequestCcBody.shape.email, name: RequestCcBody.shape.name }),
  kind: 'changes',
  idempotent: true,
  async preview(ctx, input) {
    const r = await requestOf(ctx, input.issue);
    const who = ccLine({ email: input.email, name: input.name ?? '' });
    if (r.ccs.some((c) => c.email.toLowerCase() === input.email.trim().toLowerCase())) return `${who} is copied on ${r.issue} already: nothing changes`;
    return `Copy ${who} on ${r.issue}: they get its public replies and changes of state by email from now on, as ${r.requester.name} does, and may answer by email.`;
  },
  async run(ctx, input) {
    const ccs = await addCc(ctx, input.issue, { email: input.email, ...(input.name ? { name: input.name } : {}) });
    return { data: ccs.map((c) => ({ email: c.email, name: c.name || undefined, via: c.via })), summary: `Copied ${input.email} on ${input.issue.toUpperCase()}` };
  },
});

const removeRequestCcTool = defineTool({
  name: 'remove_request_cc',
  title: 'Stop copying someone on a help desk request',
  description:
    'Take someone off a help desk request’s copies: they’re told nothing more of it, and their replies by email are refused; an email’s Cc won’t copy them again, though the team can. Taking off someone not copied changes nothing.',
  input: z.object({ issue: issueInput, email: z.string().trim().min(3).max(254).describe('The address to stop copying') }),
  kind: 'changes',
  destructive: true,
  idempotent: true,
  async preview(ctx, input) {
    const r = await requestOf(ctx, input.issue);
    const cc = r.ccs.find((c) => c.email.toLowerCase() === input.email.trim().toLowerCase());
    if (!cc) return `${input.email} isn’t copied on ${r.issue}: nothing changes`;
    return `Stop copying ${ccLine(cc)} on ${r.issue}: no more emails about it, and their replies by email are refused.`;
  },
  async run(ctx, input) {
    const ccs = await removeCc(ctx, input.issue, input.email);
    return { data: ccs.map((c) => ({ email: c.email, name: c.name || undefined, via: c.via })), summary: `Stopped copying ${input.email} on ${input.issue.toUpperCase()}` };
  },
});

export const requestCcTools: ToolDef[] = [listRequestCcsTool, addRequestCcTool, removeRequestCcTool] as unknown as ToolDef[];

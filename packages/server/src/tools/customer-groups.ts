/**
 * Customer groups for agents (D56): a desk's groups, and a request's. An agent reads them, and files
 * a request under a group, or keeps it from the group, as the team does on the request's page. Making
 * and changing groups is a desk's setting, and stays off MCP, as its other settings do.
 */
import { z } from 'zod';
import { assertCanWriteProject } from '../services/access';
import { groupByRef, listCustomerGroups } from '../services/customer-groups';
import { requestOf, updateRequest } from '../services/helpdesk';
import { resolveIssue } from '../services/issues';
import { defineTool, type ToolDef } from './types';

const listTool = defineTool({
  name: 'list_customer_groups',
  title: "A help desk's customer groups",
  description:
    "The customer groups of a project's help desk: the companies or teams its requesters belong to, by the email domains that put a requester in one, or by hand. " +
    "Each with its sharing (none; read: its members see each other's requests on the portal; comment: and answer them), whether it has its own working hours, its dedicated agents (new requests from its members go to whoever of them has the fewest open), and its open requests. " +
    'Search a group\'s requests with `customer: <name>`.',
  input: z.object({ project: z.string().describe('Project key') }),
  kind: 'reads',
  async run(ctx, i) {
    const groups = await listCustomerGroups(ctx, i.project);
    return {
      data: groups.map((g) => ({
        name: g.name,
        domains: g.domains,
        sharing: g.sharing,
        own_hours: g.businessHours ? `${g.businessHours.timeZone}, ${g.businessHours.holidays.length} holidays` : null,
        agents: g.agents.map((a) => (a.assignable ? a.user.login : `${a.user.login} (can't be given requests now)`)),
        members_by_hand: g.members,
        open_requests: g.openRequests,
      })),
      summary: groups.length ? `${groups.length} customer groups: ${groups.map((g) => g.name).join(', ')}` : `${i.project.toUpperCase()} has no customer groups`,
    };
  },
});

const input = z.object({
  issue: z.string().describe('The request, e.g. HELP-12'),
  group: z.string().nullable().optional().describe("The desk's customer group to file it under, by name; null for none; left out keeps it"),
  private: z.boolean().optional().describe("true keeps it from its group's other members on the portal; false shares it again"),
});

function said(issue: string, i: z.infer<typeof input>): string {
  const parts = [i.group === undefined ? '' : i.group === null ? 'in no customer group' : `under ${i.group}`, i.private === undefined ? '' : i.private ? 'kept from its group' : 'shared with its group'];
  return `${issue.toUpperCase()} ${parts.filter(Boolean).join(', ') || 'as it is'}`;
}

const setTool = defineTool({
  name: 'set_request_customer_group',
  title: "Change a request's customer group",
  description:
    "File a help desk request under one of its desk's customer groups, or none, or keep it from the group's other members (who see the group's requests on the portal). " +
    "Its SLA then counts in the group's hours, and one that comes into a group with dedicated agents goes to one of them unless someone chose its assignee. Takes the permission to change the project's issues. See the groups with list_customer_groups.",
  input,
  kind: 'changes',
  idempotent: true,
  async preview(ctx, i) {
    const issue = await resolveIssue(ctx, i.issue);
    await assertCanWriteProject(ctx, issue.projectId);
    if (i.group) await groupByRef(ctx.db, issue.projectId, i.group);
    await requestOf(ctx, issue.id);
    return `File ${said(i.issue, i)}`;
  },
  async run(ctx, i) {
    const r = await updateRequest(ctx, i.issue, { group: i.group, private: i.private });
    return { data: { issue: r.issue, group: r.group?.name ?? null, private: r.private }, summary: `Filed ${said(r.issue, i)}` };
  },
});

export const customerGroupTools = [listTool, setTool] as unknown as ToolDef[];

import { z } from 'zod';
import { listProjectGroups } from '../services/groups';
import { listMembers } from '../services/members';
import { getProject } from '../services/projects';
import { defineTool, type ToolDef } from './types';

const ROLE_WORDS = { viewer: 'reads and comments', member: 'changes issues', manager: 'also changes its settings and people' } as const;

const listProjectMembers = defineTool({
  name: 'list_project_members',
  title: 'Project people',
  description:
    "Who has a role in a project, by name or through a group, and what you may do in it. Someone's role is the highest of their own and their groups'. In a members-only project only these people, the people in these groups, and administrators see it, so assign its issues only to them. In an open project everyone else is a member.",
  input: z.object({ project: z.string().describe('Project key, e.g. BACK') }),
  kind: 'reads',
  async run(ctx, input) {
    const [project, members, groupRoles] = [await getProject(ctx, input.project), await listMembers(ctx, input.project), await listProjectGroups(ctx, input.project)];
    const groups = groupRoles.map((g) => ({
      name: g.group.name,
      role: g.role,
      people: g.people.map((u) => u.login),
      fromIdentityProvider: g.group.providerName ? true : undefined,
    }));
    return {
      data: {
        project: project.key,
        visibility: project.visibility === 'members' ? 'members only' : 'open',
        you: {
          role: project.access.role,
          ...(project.access.via === 'group' ? { through: `the group ${project.access.group}` } : {}),
          may: { comment: project.access.comment, changeIssues: project.access.write, manage: project.access.manage },
        },
        people: members.map((m) => ({ login: m.user.login, name: m.user.name, role: m.role, lead: m.lead || undefined, bot: m.user.isBot || undefined })),
        groups,
        roles: ROLE_WORDS,
      },
      summary: `${members.length} ${members.length === 1 ? 'person' : 'people'}${groups.length ? ` and ${groups.length} ${groups.length === 1 ? 'group' : 'groups'}` : ''} in ${project.key}`,
    };
  },
});

export const accessTools: ToolDef[] = [listProjectMembers] as unknown as ToolDef[];

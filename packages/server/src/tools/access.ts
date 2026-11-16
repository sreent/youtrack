import { z } from 'zod';
import { listMembers } from '../services/members';
import { getProject } from '../services/projects';
import { defineTool, type ToolDef } from './types';

const ROLE_WORDS = { viewer: 'reads and comments', member: 'changes issues', manager: 'also changes its settings and people' } as const;

const listProjectMembers = defineTool({
  name: 'list_project_members',
  title: 'Project people',
  description:
    "Who has a role in a project, and what you may do in it. In a members-only project only these people (and administrators) see it, so assign its issues only to them. In an open project everyone else is a member.",
  input: z.object({ project: z.string().describe('Project key, e.g. BACK') }),
  kind: 'reads',
  async run(ctx, input) {
    const [project, members] = [await getProject(ctx, input.project), await listMembers(ctx, input.project)];
    return {
      data: {
        project: project.key,
        visibility: project.visibility === 'members' ? 'members only' : 'open',
        you: { role: project.access.role, may: { comment: project.access.comment, changeIssues: project.access.write, manage: project.access.manage } },
        people: members.map((m) => ({ login: m.user.login, name: m.user.name, role: m.role, lead: m.lead || undefined, bot: m.user.isBot || undefined })),
        roles: ROLE_WORDS,
      },
      summary: `${members.length} ${members.length === 1 ? 'person' : 'people'} in ${project.key}`,
    };
  },
});

export const accessTools: ToolDef[] = [listProjectMembers] as unknown as ToolDef[];

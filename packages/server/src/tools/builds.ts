/** CI builds as an agent reads them (docs/architecture.md, D46). */
import { z } from 'zod';
import { issueBuilds, listBuilds } from '../ci/builds';
import { defineTool, type ToolDef } from './types';

const listBuildsTool = defineTool({
  name: 'list_builds',
  title: "A project's builds, or an issue's",
  description:
    "The builds CI reported for a project, newest first: each one's number or name, how it ended, its link, how many commits it holds, and what it did to each issue its commits name that you can see (marked: its build field set to the build; already: it named a build already; open: not resolved, so left; refused: why not). With issue, the builds that issue is in instead: which one it was fixed in.",
  input: z.object({
    project: z.string().optional().describe('A project key, e.g. BACK'),
    issue: z.string().optional().describe('An issue id, e.g. BACK-12, for the builds it is in'),
    limit: z.number().int().min(1).max(100).default(20),
  }),
  kind: 'reads',
  async run(ctx, input) {
    if (input.issue) {
      const list = await issueBuilds(ctx, input.issue);
      const fixed = list.find((b) => b.outcome === 'marked');
      return {
        data: list,
        summary: fixed ? `${input.issue} was fixed in build ${fixed.build}` : list.length ? `${input.issue} is in ${list.length} build(s), marked in none` : `${input.issue} is in no build yet`,
      };
    }
    if (!input.project) return { data: [], summary: 'Give a project, or an issue' };
    const list = await listBuilds(ctx, input.project, { limit: input.limit });
    return {
      data: list.map((b) => ({
        build: b.name,
        status: b.status,
        url: b.url,
        branch: b.branch,
        commits: b.commits,
        marked: b.marked,
        finished_at: b.finishedAt,
        issues: b.issues.map((i) => ({ id: i.issue.id, outcome: i.outcome, note: i.note })),
      })),
      summary: list.length ? `${list.length} build(s), the latest ${list[0]!.name} (${list[0]!.status})` : 'No builds yet',
    };
  },
});

export const buildTools: ToolDef[] = [listBuildsTool];

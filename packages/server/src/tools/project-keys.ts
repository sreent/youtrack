/**
 * Renaming a project's key (D52), for agents: the same service as the API and the web app.
 */
import { RenameProjectKeyBody } from '@a4a/shared';
import { z } from 'zod';
import { requireProject } from '../services/access';
import { renameProjectKey } from '../services/project-keys';
import { defineTool, type ToolDef } from './types';

const renameProjectKeyTool = defineTool({
  name: 'rename_project_key',
  title: "Rename a project's key",
  description:
    "Rename a project's key, as its managers can: BACK becomes CORE, and its issues keep their numbers (BACK-12 is CORE-12). The old key stays the project's for good: BACK-12 still finds the issue everywhere, `project: BACK` still finds the project in queries, and no other project can take BACK. Renaming it back to a key it had is allowed. Ask the person first: everyone who reads ids sees the new ones.",
  input: z.object({
    project: z.string().describe('The project, by its key now or one it had, e.g. BACK'),
    key: RenameProjectKeyBody.shape.key,
  }),
  kind: 'changes',
  idempotent: true,
  async preview(ctx, input) {
    const p = await requireProject(ctx, input.project, 'manage');
    const to = input.key.trim().toUpperCase();
    if (to === p.key.toUpperCase()) return `${p.key} is its key already: nothing changes`;
    return `Rename ${p.key} (${p.name}) to ${to}: ${p.key}-1 becomes ${to}-1, and so on. ${p.key} stays its own: its ids keep finding its issues.`;
  },
  async run(ctx, input) {
    const before = await requireProject(ctx, input.project, 'manage');
    const p = await renameProjectKey(ctx, input.project, { key: input.key });
    return {
      data: { key: p.key, former_keys: p.formerKeys, url: `${ctx.app.config.publicUrl}/projects/${p.key}` },
      summary: before.key.toUpperCase() === p.key ? `${p.key} is its key already` : `Renamed ${before.key} to ${p.key}`,
    };
  },
});

export const projectKeyTools: ToolDef[] = [renameProjectKeyTool as unknown as ToolDef];

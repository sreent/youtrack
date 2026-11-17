import { z } from 'zod';
import { appsForAgent } from '../services/apps';
import { defineTool, type ToolDef } from './types';

const listApps = defineTool({
  name: 'list_apps',
  title: 'Apps',
  description:
    "The apps installed in a4a that run in projects you can see (D48): what each adds to the pages (widgets, by where they show), the handlers it answers on, and what it was granted. People install and remove apps; an agent can't. A handler is called at POST /api/v1/apps/{app}/handlers/{handler}.",
  input: z.object({}),
  kind: 'reads',
  async run(ctx) {
    const apps = await appsForAgent(ctx);
    return { data: { apps }, summary: apps.length ? `${apps.length} ${apps.length === 1 ? 'app' : 'apps'}: ${apps.map((a) => a.title).join(', ')}` : 'No apps run where you can see' };
  },
});

export const appTools: ToolDef[] = [listApps] as unknown as ToolDef[];

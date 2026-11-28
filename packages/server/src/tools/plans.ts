import type { ToolDef } from './types';

/**
 * MCP tools for plans of a search (docs/architecture.md, D72), such as `move_task`, whose preview is a
 * move's dry run (P6). Registered in tools/registry.ts, so the packages that bring them add their tools
 * here and touch no registry. Today's planning tools stay in tools/planning.ts, their names and shapes
 * as they are.
 */
export const plansTools: ToolDef[] = [];

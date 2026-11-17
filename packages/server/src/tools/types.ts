import type { z } from 'zod';
import type { Ctx } from '../context';

export type ToolKind = 'reads' | 'changes';

export interface ToolResult {
  /** What the agent reads (JSON). */
  data: unknown;
  /** One line for people: shown in the assistant's run and the history. */
  summary: string;
}

export interface ToolDef<S extends z.ZodObject<z.ZodRawShape> = z.ZodObject<z.ZodRawShape>> {
  name: string;
  title: string;
  description: string;
  input: S;
  kind: ToolKind;
  /** May overwrite existing data (MCP destructiveHint). Additive writes are false. */
  destructive?: boolean;
  idempotent?: boolean;
  /** Asks a4a's own AI: offered only while the server has an AI provider (D59). */
  needsAI?: boolean;
  run(ctx: Ctx, input: z.infer<S>): Promise<ToolResult>;
  /** For writes: what will happen, in words, for an approval. Uses dry runs where it can. */
  preview?(ctx: Ctx, input: z.infer<S>): Promise<string>;
}

export function defineTool<S extends z.ZodObject<z.ZodRawShape>>(def: ToolDef<S>): ToolDef<S> {
  return def;
}

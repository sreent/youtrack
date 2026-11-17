/**
 * A summary of an issue for agents (D59): a4a's own AI reads the whole thread as the caller sees it.
 * The writing actions aren't tools: an agent is a model, and writes its own words.
 */
import { LOCALES } from '@a4a/shared/i18n';
import { z } from 'zod';
import { summarizeIssue } from '../ai/writing';
import { defineTool, type ToolDef } from './types';

const summarizeIssueTool = defineTool({
  name: 'summarize_issue',
  title: 'Summarise an issue',
  description:
    "A short summary of an issue and its discussion by a4a's own AI: where it stands, what was found or decided, what is still open, and who is on it. It reads the description and the whole thread as you may see it (up to about 60,000 characters, the latest comments first), where get_issue gives the latest 50 comments; it never reads what is kept from you. Each call counts against the hourly allowance of AI help of the person your token acts for. When you need the facts themselves, read get_issue: a summary is a model's reading of them.",
  input: z.object({
    issue: z.string().describe('Readable id, e.g. BACK-12'),
    language: z.enum(LOCALES).optional().describe('The language to write it in; left out, the language a4a knows the person by'),
  }),
  kind: 'reads',
  idempotent: true,
  needsAI: true,
  async run(ctx, input) {
    const r = await summarizeIssue(ctx, input.issue, input.language);
    const id = input.issue.toUpperCase();
    return { data: { issue: id, summary: r.summary, language: r.language, partial: r.partial }, summary: `Summarised ${id}` };
  },
});

export const writingTools: ToolDef[] = [summarizeIssueTool] as unknown as ToolDef[];

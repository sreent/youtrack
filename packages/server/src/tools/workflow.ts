/**
 * Workflow rules for agents: what rules there are, and what one would do. Agents can't make or
 * change rules (docs/architecture.md, D18): a rule acts later, on its own and on every issue that
 * matches it, so it is a person's to make.
 */
import { RULE_EVERY, RULE_KINDS, RULE_TRIGGERS, type RuleInput, type RuleProblem } from '@a4a/shared';
import { z } from 'zod';
import { badRequest } from '../lib/errors';
import { withFixes } from '../search/lexer';
import { getRule, listRules, previewRule } from '../workflow/rules';
import { defineTool, type ToolDef } from './types';

const change = (c: { field: string; from: string | null; to: string | null }) => `${c.field}: ${c.from ?? '—'} → ${c.to ?? '—'}`;

/** Each part's text with the fixes of its problems applied, where every one of them has a fix. */
function fixed(draft: RuleInput, problems: RuleProblem[]): Record<string, string> | undefined {
  const out: Record<string, string> = {};
  for (const part of ['query', 'requires', 'command'] as const) {
    const mine = problems.filter((p) => p.part === part);
    const text = draft[part];
    if (!mine.length || typeof text !== 'string') continue;
    const f = withFixes(text, mine);
    if (f !== null) out[part] = f;
  }
  return Object.keys(out).length ? out : undefined;
}

const listRulesTool = defineTool({
  name: 'list_rules',
  title: 'Workflow rules',
  description:
    "The workflow rules that apply in a project (its own and those for every project), each in words: when it acts, on which issues, and what it changes, or what change it refuses. Also when it next runs, what it did last, and anything in it that no longer reads. Rules act on their own, as the workflow agent, so a change you see by 'workflow' came from one of these.",
  input: z.object({ project: z.string().optional().describe('Project key; without it, every rule you can see') }),
  kind: 'reads',
  async run(ctx, input) {
    const rules = await listRules(ctx, { project: input.project });
    return {
      data: rules.map((r) => ({
        id: r.id,
        name: r.name,
        project: r.project ?? 'every project',
        kind: r.kind,
        on: r.enabled,
        rule: r.sentence,
        problems: r.problems.length ? r.problems.map((p) => `${p.part}: ${p.hint ? `${p.message} (${p.hint})` : p.message}`) : undefined,
        nextRun: r.nextRunAt ?? undefined,
        lastRun: r.lastRun ? { at: r.lastRun.at.slice(0, 16).replace('T', ' '), outcome: r.lastRun.outcome, issue: r.lastRun.issue, said: r.lastRun.message } : undefined,
      })),
      summary: `${rules.length} ${rules.length === 1 ? 'rule' : 'rules'}${input.project ? ` in ${input.project.toUpperCase()}` : ''}`,
    };
  },
});

const previewRuleTool = defineTool({
  name: 'preview_rule',
  title: 'Preview a rule',
  description:
    "What a workflow rule would do, without saving or changing anything: what needs fixing in it (with the text fixed, where a4a knows the fix), how many issues match it now, and what its command would change on a few of them, as a dry run. Pass `rule` for a saved one, or describe one. Kinds: 'change' acts when an issue is created, changes (optionally only `field`) or gets a comment, if it then matches `query`; 'schedule' gives every issue matching `query` the command, every hour, day or weekday at `at`; 'guard' refuses a change that would make an issue match `query` without matching `requires`. Agents can't make rules: give the person the preview, and they can make it on the Rules page.",
  input: z.object({
    rule: z.string().optional().describe('A saved rule id; or describe one with the fields below'),
    project: z.string().optional().describe('Project key; leave out for a rule for every project'),
    name: z.string().max(80).optional(),
    kind: z.enum(RULE_KINDS).optional(),
    trigger: z.enum(RULE_TRIGGERS).optional().describe("A 'change' rule: what sets it off"),
    field: z.string().max(60).optional().describe("A 'change' rule on 'updated': only when this field changes"),
    every: z.enum(RULE_EVERY).optional().describe("A 'schedule' rule: how often"),
    at: z.string().optional().describe("A 'schedule' rule: the time of day, HH:MM"),
    query: z.string().max(2000).optional().describe('Which issues, in the query language'),
    command: z.string().max(2000).optional().describe('What to change, in the command language'),
    comment: z.string().max(5000).optional(),
    requires: z.string().max(2000).optional().describe("A 'guard': what the issue must also match"),
    message: z.string().max(500).optional().describe("A 'guard': what a refused change is told"),
  }),
  kind: 'reads',
  async run(ctx, input) {
    let draft: RuleInput;
    if (input.rule) {
      const r = await getRule(ctx, input.rule);
      draft = { project: r.project, name: r.name, kind: r.kind, trigger: r.trigger, field: r.field, schedule: r.schedule, query: r.query, command: r.command, comment: r.comment, requires: r.requires, message: r.message };
    } else {
      if (!input.kind) throw badRequest('Say which kind of rule it is: change, schedule or guard', 'Or pass rule, the id of a saved one (list_rules).');
      draft = {
        project: input.project ?? null,
        name: input.name ?? 'A rule',
        kind: input.kind,
        trigger: input.trigger ?? null,
        field: input.field ?? null,
        schedule: input.every ? { every: input.every, ...(input.at ? { at: input.at } : {}) } : null,
        query: input.query ?? '',
        command: input.command ?? '',
        comment: input.comment ?? null,
        requires: input.requires ?? null,
        message: input.message ?? null,
      };
    }
    const p = await previewRule(ctx, draft);
    return {
      data: {
        ok: p.ok,
        rule: p.sentence,
        problems: p.problems.length ? p.problems.map((x) => ({ part: x.part, problem: x.message, hint: x.hint, fix: x.fix })) : undefined,
        fixed: fixed(draft, p.problems),
        matching: p.matching,
        breaking: p.breaking ?? undefined,
        sample: p.sample.map((x) => ({ issue: x.issue.id, summary: x.issue.summary, changes: x.changes.map(change), errors: x.errors.length ? x.errors : undefined })),
        note: p.note,
      },
      summary: p.ok ? `Previewed: ${p.matching} ${p.matching === 1 ? 'issue matches' : 'issues match'}` : `The rule needs fixing: ${p.problems.length} ${p.problems.length === 1 ? 'problem' : 'problems'}`,
    };
  },
});

export const workflowTools: ToolDef[] = [listRulesTool, previewRuleTool] as unknown as ToolDef[];

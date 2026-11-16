import type { Ctx } from '../context';
import { todayISO } from '../lib/dates';
import { visibleSchema } from '../services/access';
import { allowedValues, type SchemaSnapshot } from '../services/schema-cache';

/**
 * A compact picture of the tracker for prompts: projects, fields and values, people, tags, link
 * phrases. Only what the caller can see goes to Claude: a project they can't see isn't named.
 */
export async function schemaSummary(ctx: Ctx, opts: { projectId?: string; maxUsers?: number } = {}): Promise<string> {
  const s = await visibleSchema(ctx);
  const projects = opts.projectId ? [s.projects.get(opts.projectId)!].filter(Boolean) : [...s.projects.values()].filter((p) => !p.archived);
  const lines: string[] = [];
  lines.push(`Today: ${todayISO()}. You act for ${ctx.actor.user.name} (login "${ctx.actor.user.login}"; "me" in queries).`);
  lines.push(`Projects: ${projects.map((p) => `${p.key} (${p.name})`).join(', ')}`);
  lines.push('Fields:');
  for (const line of fieldLines(s, projects.map((p) => p.id))) lines.push(`- ${line}`);
  const people = [...s.users.values()].filter((u) => !u.banned).slice(0, opts.maxUsers ?? 200);
  lines.push(`People (login: name): ${people.map((u) => `${u.login}: ${u.name}${u.isBot ? ' (bot)' : ''}`).join('; ')}`);
  if (s.tags.size) lines.push(`Tags: ${[...s.tags.values()].map((t) => t.name).join(', ')}`);
  lines.push(`Link phrases: ${[...new Set(s.linkPhrases.map((p) => p.display))].join(', ')}`);
  return lines.join('\n');
}

function fieldLines(s: SchemaSnapshot, projectIds: string[]): string[] {
  const fieldIds = new Set<string>();
  for (const pid of projectIds) for (const pf of s.projectFields.get(pid) ?? []) fieldIds.add(pf.fieldId);
  const out: string[] = [];
  for (const id of fieldIds) {
    const f = s.fields.get(id);
    if (!f) continue;
    if (f.type === 'enum' || f.type === 'state' || f.type === 'version') {
      const values = new Map<string, boolean>();
      for (const pid of projectIds) for (const v of allowedValues(s, f.id, pid)) values.set(v.name, v.isResolved);
      const list = [...values].map(([n, resolved]) => (resolved ? `${n} (resolved)` : n)).join(', ');
      out.push(`${f.name} (${f.type}${f.multi ? ', several' : ''}): ${list || '(no values)'}`);
    } else {
      out.push(`${f.name} (${f.type}${f.type === 'period' ? ', e.g. 2d 4h' : f.type === 'date' ? ', YYYY-MM-DD' : ''})`);
    }
  }
  return out;
}

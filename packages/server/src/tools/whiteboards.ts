/**
 * Whiteboards (D58), for agents and the assistant: list them, read one as structured text, add notes
 * and cards, and make issues of notes and links of arrows, previewed by a dry run of the same service
 * the page uses. Deleting a whiteboard stays a person's (D8).
 */
import { WHITEBOARD_LIMITS, WHITEBOARD_TONES, whiteboardOutline, type WhiteboardCard, type WhiteboardElement, type WhiteboardOp } from '@a4a/shared';
import { z } from 'zod';
import type { Ctx } from '../context';
import { AppError, badRequest, notFound } from '../lib/errors';
import { newId } from '../lib/ids';
import { resolveArticle } from '../services/article-refs';
import { resolveIssue } from '../services/issues';
import { applyWhiteboardBatch, convertWhiteboard, getWhiteboard, listWhiteboards, requireWhiteboard } from '../services/whiteboards';
import { defineTool, type ToolDef } from './types';

const whiteboardInput = z.string().trim().min(1).max(160).describe('The whiteboard: its id from list_whiteboards, or its exact name');

/** A whiteboard by id, or by its name among those the caller sees; a hidden one is as missing as one that isn't. */
async function boardId(ctx: Ctx, ref: string): Promise<string> {
  try {
    return (await requireWhiteboard(ctx, ref)).id;
  } catch (e) {
    if (!(e instanceof AppError) || e.status !== 404) throw e;
  }
  const named = (await listWhiteboards(ctx)).filter((w) => w.name.toLowerCase() === ref.trim().toLowerCase());
  if (named.length === 1) return named[0]!.id;
  // api only: an MCP tool's input, which agents read in English
  if (named.length > 1) throw badRequest(`${named.length} whiteboards are called "${ref}"`, `Give its id: ${named.map((w) => `${w.id} (${w.project.key})`).join(', ')}.`);
  throw notFound('Whiteboard').said('notFound.whiteboard');
}

function cardWords(card: WhiteboardCard | undefined): Record<string, unknown> {
  if (!card?.shown) return { hidden: true };
  return {
    ...(card.id ? { ref: card.id } : {}),
    summary: card.summary,
    ...(card.state ? { state: card.state.name } : {}),
    ...(card.assignee ? { assignee: card.assignee.login } : {}),
    ...(card.resolved ? { resolved: true } : {}),
  };
}

function describe(e: WhiteboardElement, cards: Map<string, WhiteboardCard>): Record<string, unknown> {
  if (e.kind === 'note') return { id: e.id, kind: 'note', text: e.text ?? '', ...(e.tone && e.tone !== 'plain' ? { tone: e.tone } : {}) };
  if (e.kind === 'text' || e.kind === 'section') return { id: e.id, kind: e.kind, text: e.text ?? '' };
  return { id: e.id, kind: e.kind, ...cardWords(cards.get(e.id)) };
}

function line(e: WhiteboardElement, cards: Map<string, WhiteboardCard>): string {
  const quote = (t: string | null) => JSON.stringify((t ?? '').replace(/\s+/g, ' ').trim());
  if (e.kind === 'note') return `- note ${e.id}${e.tone && e.tone !== 'plain' ? ` [${e.tone}]` : ''}: ${quote(e.text)}`;
  if (e.kind === 'text') return `- text ${e.id}: ${quote(e.text)}`;
  const c = cards.get(e.id);
  if (!c?.shown) return `- ${e.kind} card ${e.id}: hidden (you can't see it, or it's gone)`;
  if (e.kind === 'article') return `- article ${c.id} (card ${e.id}): ${quote(c.summary ?? '')}`;
  return `- issue ${c.id} (card ${e.id}): ${quote(c.summary ?? '')}${c.state ? `, ${c.state.name}` : ''}${c.assignee ? `, assigned to ${c.assignee.login}` : ''}`;
}

const listWhiteboardsTool = defineTool({
  name: 'list_whiteboards',
  title: 'List whiteboards',
  description: 'The whiteboards of the projects you can see, or of one: where a team plans and brainstorms beside its issues, in notes, cards and arrows. Each with its id, project and how many elements it holds.',
  input: z.object({ project: z.string().trim().max(40).optional().describe('A project’s key, e.g. BACK') }),
  kind: 'reads',
  async run(ctx, input) {
    const all = await listWhiteboards(ctx, { project: input.project });
    return {
      data: all.map((w) => ({ id: w.id, name: w.name, project: w.project.key, elements: w.elements, updated: w.updatedAt, can_edit: w.access.edit })),
      summary: all.length ? `${all.length} whiteboard${all.length === 1 ? '' : 's'}` : 'No whiteboards',
    };
  },
});

const getWhiteboardTool = defineTool({
  name: 'get_whiteboard',
  title: 'Read a whiteboard',
  description:
    'A whiteboard as structured text, in reading order: its sections and what lies in each, what lies in none, then its arrows (what each joins, its label, and the link it became). Notes say their words and tone; issue cards their issue, summary, state and assignee; a card you may not see says only that it is hidden. Element ids are what add_to_whiteboard and convert_whiteboard_notes take.',
  input: z.object({ whiteboard: whiteboardInput }),
  kind: 'reads',
  async run(ctx, input) {
    const d = await getWhiteboard(ctx, await boardId(ctx, input.whiteboard));
    const cards = new Map(d.cards.map((c) => [c.element, c]));
    const o = whiteboardOutline(d.elements);
    const byId = new Map(d.elements.map((e) => [e.id, e]));
    const end = (id: string | null) => {
      const e = id ? byId.get(id) : undefined;
      if (!e) return id ?? '?';
      const c = cards.get(e.id);
      return c?.shown && c.id ? `${c.id} (${e.id})` : `${e.kind} ${e.id}`;
    };
    const lines = [
      `${d.whiteboard.name} (${d.whiteboard.project.key}), ${d.elements.length} element${d.elements.length === 1 ? '' : 's'}`,
      ...o.sections.flatMap((s) => [`## ${s.section.text || 'Untitled section'} (section ${s.section.id})`, ...s.inside.map((e) => line(e, cards))]),
      ...(o.loose.length ? [o.sections.length ? '## In no section' : '## Elements', ...o.loose.map((e) => line(e, cards))] : []),
      ...(o.arrows.length
        ? ['## Arrows', ...o.arrows.map((a) => `- ${a.id}: ${end(a.from)} → ${end(a.to)}${a.label ? ` "${a.label}"` : ''}${a.linked ? ` (linked: ${a.linked})` : ''}`)]
        : []),
    ];
    return {
      data: {
        id: d.whiteboard.id,
        name: d.whiteboard.name,
        project: d.whiteboard.project.key,
        can_edit: d.whiteboard.access.edit,
        looking: d.viewers.map((v) => v.user.login),
        sections: o.sections.map((s) => ({ id: s.section.id, title: s.section.text ?? '', holds: s.inside.map((e) => describe(e, cards)) })),
        elsewhere: o.loose.map((e) => describe(e, cards)),
        arrows: o.arrows.map((a) => ({ id: a.id, from: a.from, to: a.to, ...(a.label ? { label: a.label } : {}), ...(a.linked ? { linked: a.linked } : {}) })),
        outline: lines.join('\n'),
      },
      summary: `${d.whiteboard.name}: ${d.elements.length} element${d.elements.length === 1 ? '' : 's'}`,
    };
  },
});

const ref = z.string().trim().min(1).max(64).optional().describe('A name for it within this call, for an arrow to start or end at');
const addInput = z.object({
  whiteboard: whiteboardInput,
  notes: z
    .array(z.object({ text: z.string().trim().min(1).max(WHITEBOARD_LIMITS.text), tone: z.enum(WHITEBOARD_TONES).optional().describe('What it is: idea, agreed, question, problem or parked'), ref }))
    .max(50)
    .default([]),
  issues: z.array(z.object({ issue: z.string().trim().min(1).max(40).describe('e.g. BACK-12'), ref })).max(50).default([]),
  articles: z.array(z.object({ article: z.string().trim().min(1).max(40).describe('e.g. BACK-A-3'), ref })).max(50).default([]),
  arrows: z
    .array(
      z.object({
        from: z.string().trim().min(1).max(64).describe('An element’s id on the whiteboard, or a ref given in this call'),
        to: z.string().trim().min(1).max(64),
        label: z.string().trim().max(WHITEBOARD_LIMITS.label).optional(),
      }),
    )
    .max(50)
    .default([]),
  section: z.string().trim().max(64).optional().describe('A section’s id, to put the new notes and cards in it; else they go below what is there'),
});

/** Where new elements go: in a grid inside the section asked for, else below everything, in rows of four. */
function placeNew(elements: WhiteboardElement[], n: number, section: WhiteboardElement | undefined): { x: number; y: number }[] {
  const cellW = 240;
  const cellH = 160;
  if (section) {
    const columns = Math.max(1, Math.floor((section.w - 32) / cellW));
    const inside = elements.filter((e) => e.kind !== 'section' && e.kind !== 'arrow' && e.x >= section.x && e.y >= section.y && e.x <= section.x + section.w && e.y <= section.y + section.h);
    const top = inside.length ? Math.max(...inside.map((e) => e.y + e.h)) + 24 : section.y + 48;
    return Array.from({ length: n }, (_, i) => ({ x: section.x + 16 + (i % columns) * cellW, y: top + Math.floor(i / columns) * cellH }));
  }
  const placed = elements.filter((e) => e.kind !== 'arrow');
  const left = placed.length ? Math.min(...placed.map((e) => e.x)) : 0;
  const top = placed.length ? Math.max(...placed.map((e) => e.y + e.h)) + 48 : 0;
  return Array.from({ length: n }, (_, i) => ({ x: left + (i % 4) * cellW, y: top + Math.floor(i / 4) * cellH }));
}

async function planAdd(ctx: Ctx, input: z.infer<typeof addInput>) {
  const id = await boardId(ctx, input.whiteboard);
  const d = await getWhiteboard(ctx, id);
  const section = input.section ? d.elements.find((e) => e.id === input.section && e.kind === 'section') : undefined;
  // api only: an MCP tool's input, which agents read in English
  if (input.section && !section) throw badRequest(`There is no section ${input.section} on ${d.whiteboard.name}`, 'Take a section’s id from get_whiteboard.');
  const items = [
    ...input.notes.map((n) => ({ kind: 'note' as const, ref: n.ref, text: n.text, tone: n.tone })),
    ...input.issues.map((i) => ({ kind: 'issue' as const, ref: i.ref, issue: i.issue })),
    ...input.articles.map((a) => ({ kind: 'article' as const, ref: a.ref, article: a.article })),
  ];
  const at = placeNew(d.elements, items.length, section);
  const refs = new Map<string, string>();
  const ops: WhiteboardOp[] = items.map((item, i) => {
    const eid = newId(12);
    if (item.ref) refs.set(item.ref, eid);
    return { op: 'add', id: eid, kind: item.kind, x: at[i]!.x, y: at[i]!.y, ...('text' in item ? { text: item.text, ...(item.tone ? { tone: item.tone } : {}) } : {}), ...('issue' in item ? { issue: item.issue } : {}), ...('article' in item ? { article: item.article } : {}) };
  });
  for (const a of input.arrows) ops.push({ op: 'add', id: newId(12), kind: 'arrow', x: 0, y: 0, from: refs.get(a.from) ?? a.from, to: refs.get(a.to) ?? a.to, ...(a.label ? { label: a.label } : {}) });
  // A section grows to hold what was put in it.
  if (section && items.length) {
    const bottom = Math.max(...at.map((p) => p.y)) + 160;
    if (bottom > section.y + section.h) ops.push({ op: 'update', id: section.id, set: { h: Math.min(WHITEBOARD_LIMITS.maxSize, bottom - section.y) } });
  }
  return { id, d, ops, items };
}

const addToWhiteboardTool = defineTool({
  name: 'add_to_whiteboard',
  title: 'Add notes and cards to a whiteboard',
  description: `Add notes (words, and a tone: idea, agreed, question, problem or parked), issue cards and article cards to a whiteboard, and arrows between what's there or what this call adds (give an item a ref, and an arrow its refs or element ids). They go below what's there, or into a section. A card shows its issue as each reader may see it. At most ${WHITEBOARD_LIMITS.elements} elements on a whiteboard.`,
  input: addInput,
  kind: 'changes',
  async preview(ctx, input) {
    const { d, items } = await planAdd(ctx, input);
    for (const i of items) {
      if (i.kind === 'issue') await resolveIssue(ctx, i.issue);
      if (i.kind === 'article') await resolveArticle(ctx, i.article);
    }
    const parts = [
      input.notes.length ? `${input.notes.length} note${input.notes.length === 1 ? '' : 's'} (${input.notes.map((n) => `“${n.text.split('\n')[0]!.slice(0, 60)}”`).join(', ')})` : '',
      input.issues.length ? `issue card${input.issues.length === 1 ? '' : 's'} ${input.issues.map((i) => i.issue.toUpperCase()).join(', ')}` : '',
      input.articles.length ? `article card${input.articles.length === 1 ? '' : 's'} ${input.articles.map((a) => a.article.toUpperCase()).join(', ')}` : '',
      input.arrows.length ? `${input.arrows.length} arrow${input.arrows.length === 1 ? '' : 's'}` : '',
    ].filter(Boolean);
    return parts.length ? `Add ${parts.join(', ')} to the whiteboard ${d.whiteboard.name} (${d.whiteboard.project.key}).` : 'Nothing to add.';
  },
  async run(ctx, input) {
    const { id, d, ops } = await planAdd(ctx, input);
    // api only: an MCP tool's input, which agents read in English
    if (!ops.length) throw badRequest('Nothing to add', 'Give notes, issues, articles or arrows.');
    const res = await applyWhiteboardBatch(ctx, id, { ops });
    const added = res.elements.filter((e) => ops.some((o) => o.op === 'add' && o.id === e.id));
    return {
      data: { added: added.map((e) => ({ id: e.id, kind: e.kind })), refused: res.refused.map((r) => ({ id: r.id, reason: r.reason })) },
      summary: `Added ${added.length} element${added.length === 1 ? '' : 's'} to ${d.whiteboard.name}${res.refused.length ? `; ${res.refused.length} refused` : ''}`,
    };
  },
});

const convertInput = z.object({
  whiteboard: whiteboardInput,
  project: z.string().trim().max(40).optional().describe('Where the notes’ issues go, e.g. BACK: a project the person may report issues in. Needed with notes'),
  notes: z.array(z.string().trim().min(1).max(64)).max(WHITEBOARD_LIMITS.convert).default([]).describe('Notes’ element ids: each becomes an issue, its first line the summary and the rest the description'),
  links: z
    .array(z.object({ arrow: z.string().trim().min(1).max(64), relation: z.string().trim().min(1).max(100).describe('e.g. "depends on", "relates to": how the issue at its start relates to the one at its end') }))
    .max(WHITEBOARD_LIMITS.convert)
    .default([])
    .describe('Arrows between issues, or notes converted in this call, to make links of'),
  dry_run: z.boolean().optional().describe('Only say what would happen'),
});

const convertTool = defineTool({
  name: 'convert_whiteboard_notes',
  title: 'Make issues of whiteboard notes, and links of arrows',
  description:
    'Turn notes on a whiteboard into issues in a project, each card becoming its issue’s where the note was, and arrows between issues into links of the type named; the new issues’ history says which whiteboard they came from. Each converts on its own: one that fails says why, and the rest still convert. A note converted already, or a link that exists, is never made twice. Ask the person first; `dry_run` says what would happen.',
  input: convertInput,
  kind: 'changes',
  idempotent: true,
  async preview(ctx, input) {
    const id = await boardId(ctx, input.whiteboard);
    const r = await convertWhiteboard(ctx, id, { project: input.project, notes: input.notes, links: input.links, dryRun: true });
    const ok = r.notes.filter((n) => n.ok && !n.already);
    const lines = [
      ok.length ? `Make ${ok.length} issue${ok.length === 1 ? '' : 's'} in ${input.project?.toUpperCase()}: ${ok.map((n) => `“${n.summary}”`).join(', ')}.` : '',
      ...r.notes.filter((n) => n.already).map((n) => `${n.element} is an issue already${n.issue ? ` (${n.issue})` : ''}: nothing is made.`),
      ...r.links.filter((l) => l.ok).map((l) => (l.made === false ? `${l.link}: linked already, nothing is made.` : `Link: ${l.link}.`)),
      ...[...r.notes, ...r.links].filter((x) => !x.ok).map((x) => `${x.element} can't: ${x.problem?.message}${x.problem?.hint ? `. ${x.problem.hint}` : ''}`),
    ].filter(Boolean);
    return lines.join('\n') || 'Nothing to convert.';
  },
  async run(ctx, input) {
    const id = await boardId(ctx, input.whiteboard);
    const r = await convertWhiteboard(ctx, id, { project: input.project, notes: input.notes, links: input.links, dryRun: input.dry_run ?? false });
    const made = r.notes.filter((n) => n.ok && n.issue && !n.already).map((n) => n.issue!);
    const linked = r.links.filter((l) => l.ok && l.made).length;
    const failed = [...r.notes, ...r.links].filter((x) => !x.ok).length;
    return {
      data: {
        notes: r.notes.map((n) => ({ element: n.element, ok: n.ok, ...(n.issue ? { issue: n.issue } : {}), ...(n.already ? { already: true } : {}), ...(n.problem ? { problem: n.problem.hint ? `${n.problem.message}. ${n.problem.hint}` : n.problem.message } : {}) })),
        links: r.links.map((l) => ({ element: l.element, ok: l.ok, ...(l.link ? { link: l.link } : {}), ...(l.made !== undefined ? { made: l.made } : {}), ...(l.problem ? { problem: l.problem.hint ? `${l.problem.message}. ${l.problem.hint}` : l.problem.message } : {}) })),
      },
      summary: r.dryRun
        ? 'Dry run: nothing changed'
        : `${made.length ? `Made ${made.join(', ')}` : 'Made no issue'}${linked ? `, and ${linked} link${linked === 1 ? '' : 's'}` : ''}${failed ? `; ${failed} failed` : ''}`,
    };
  },
});

export const whiteboardTools: ToolDef[] = [listWhiteboardsTool, getWhiteboardTool, addToWhiteboardTool, convertTool] as unknown as ToolDef[];

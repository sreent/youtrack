/**
 * Moving an issue to another project, and cloning one (D41).
 *
 * A move gives the issue the next number of the project it joins. The id it had stays its alias
 * (issue_aliases), so addresses, the API, MCP, Markdown and commit messages that name it still find
 * it. Its values carry over by name: a value the other project doesn't have, a person who can't see
 * it, a field it requires and the issue lacks, each is a problem with its fix, and nothing moves
 * until the caller has given a value (or null) for each. It leaves the project and joins the other,
 * so it takes the right to change issues in both.
 *
 * A clone is a new issue in the same project or another: the summary, description, values and
 * tags, a "clones" link back, and its parent if it had one. Comments, files, work, votes, other
 * links and watchers stay with the original.
 */
import { isOptionType, type CloneIssueInput, type IssueDetail, type MoveIssueInput, type MovePlan, type MoveProblem } from '@a4a/shared';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { requireScope, type Ctx } from '../context';
import type { Db } from '../db/client';
import { CLONE_LINK } from '../db/defaults';
import { issueAliases, issueFieldValues, issueLinks, issues, issueTags, mentions, projects, sprintIssues, tags } from '../db/schema';
import { publishActivities, recordActivity } from '../events/activity';
import { AppError, badRequest, conflict, keyedProblem, notFound, saidProblems, wordsOf } from '../lib/errors';
import { todayIn } from '../reports/tz';
import { assertCanWriteProject, canReadProject, projectAccess } from './access';
import { issueRef, issueRefsById, readableId, stateNames, type IssueRow } from './issue-refs';
import { createIssue, fieldValuesOf, resolveIssue } from './issues';
import { allowedValues, projectByKey, type FieldRow, type ProjectRow, type SchemaSnapshot } from './schema-cache';
import { zoneOf } from './time-zones';
import { presentValues, resolveFieldInput, valueRow, type ResolvedValue } from './values';
import { whoSees } from './watchers';

type Carried = { values: ResolvedValue[]; problem?: undefined } | { values?: undefined; problem: Omit<MoveProblem, 'field' | 'choices'> };

/** An issue's values for `field`, as the project it goes to takes them: the same value, one of the same name, or a problem. */
async function carryValues(db: Db, s: SchemaSnapshot, field: FieldRow, target: ProjectRow, before: ResolvedValue[]): Promise<Carried> {
  if (isOptionType(field.type)) {
    const allowed = allowedValues(s, field.id, target.id);
    const out: ResolvedValue[] = [];
    for (const v of before) {
      if (!v.valueId) continue;
      if (allowed.some((a) => a.id === v.valueId)) {
        out.push(v);
        continue;
      }
      const name = s.values.get(v.valueId)?.name ?? '';
      const same = allowed.find((a) => a.name.toLowerCase() === name.toLowerCase());
      if (!same) {
        return {
          problem: keyedProblem(
            { message: `${field.name} "${name}" isn't a value in ${target.key}`, hint: `Choose one of its values for ${field.name}, or null to leave it empty.` },
            'move.notAValueThere',
            { field: field.name, value: name, project: target.key },
          ),
        };
      }
      out.push({ valueId: same.id });
    }
    return { values: out };
  }
  if (field.type === 'user') {
    const people = before.flatMap((v) => (v.userId && s.users.get(v.userId) ? [s.users.get(v.userId)!] : []));
    const seeing = await whoSees(db, s, target.id, people.map((u) => u.login));
    const blind = people.find((u) => !seeing.has(u.login.toLowerCase()));
    if (blind) {
      return {
        problem: keyedProblem(
          { message: `${blind.name} can't see ${target.key}, so can't stay ${field.name}`, hint: `Choose someone who can, or null to leave ${field.name} empty.` },
          'move.cantSeeTarget',
          { name: blind.name, project: target.key, field: field.name },
        ),
      };
    }
    return { values: before };
  }
  return { values: before };
}

interface Planned {
  s: SchemaSnapshot;
  plan: MovePlan;
  target: ProjectRow;
  values: Map<string, ResolvedValue[]>;
  /** Sprints it leaves: theirs are boards that show none of the project it joins. */
  leaving: string[];
  /** The values it leaves behind, with the fields the project it joins doesn't have. */
  droppedValues: { field: string; from: string | null }[];
}

async function planMove(ctx: Ctx, db: Db, issue: IssueRow, input: MoveIssueInput): Promise<Planned> {
  const s = await ctx.app.schema.get(db);
  const view = await projectAccess(ctx, db);
  const asked = input.project.trim();
  const target = projectByKey(s, asked) ?? [...s.projects.values()].find((p) => p.name.toLowerCase() === asked.toLowerCase());
  if (!target || !view.canRead(target.id)) {
    const open = [...s.projects.values()].filter((p) => view.canWrite(p.id) && !p.archived && p.id !== issue.projectId).map((p) => p.key);
    throw notFound(`Project ${asked}`, open.length ? `Projects it can move to: ${open.join(', ')}` : 'There is no other project you can move it to.').said('move.projectNotFound', { project: asked, n: open.length, projects: open.join(', ') });
  }
  const from = readableId(s, issue);
  if (target.id === issue.projectId) throw badRequest(`${from} is in ${target.key} already`).said('move.alreadyThere', { issue: from, project: target.key });
  if (target.archived) throw badRequest(`Project ${target.key} is archived`, 'Nothing moves into an archived project.').said('move.targetArchived', { project: target.key });
  // It leaves one project and joins another: it changes both.
  await assertCanWriteProject(ctx, issue.projectId, db);
  await assertCanWriteProject(ctx, target.id, db);

  const current = await fieldValuesOf(db, issue.id);
  const given = new Map(Object.entries(input.fields ?? {}).map(([k, v]) => [k.trim().toLowerCase(), v]));
  const zone = zoneOf(ctx);
  const today = todayIn(zone);
  const problems: MoveProblem[] = [];
  const carried: MovePlan['carried'] = [];
  const values = new Map<string, ResolvedValue[]>();
  const pfs = s.projectFields.get(target.id) ?? [];
  for (const pf of pfs) {
    const f = s.fields.get(pf.fieldId);
    if (!f) continue;
    const before = current.get(f.id) ?? [];
    const choices = isOptionType(f.type) ? allowedValues(s, f.id, target.id).map((v) => v.name) : undefined;
    const problem = (p: Omit<MoveProblem, 'field' | 'choices'>) => problems.push({ field: f.name, ...p, ...(choices ? { choices } : {}) });
    let after: ResolvedValue[] = [];
    if (given.has(f.name.toLowerCase())) {
      const g = given.get(f.name.toLowerCase());
      if (g !== null && g !== undefined && !(Array.isArray(g) && !g.length)) {
        try {
          after = resolveFieldInput(s, f, target.id, g as string | string[], ctx.actor.user.id, today, zone);
        } catch (e) {
          problem({ message: (e as Error).message, ...((e as { hint?: string }).hint ? { hint: (e as { hint?: string }).hint } : {}), ...(e instanceof AppError ? wordsOf(e) : {}) });
          continue;
        }
      }
    } else if (before.length) {
      const c = await carryValues(db, s, f, target, before);
      if (c.problem) {
        problem(c.problem);
        continue;
      }
      after = c.values;
    } else if (pf.defaultValue !== null && pf.defaultValue !== undefined) {
      try {
        after = resolveFieldInput(s, f, target.id, pf.defaultValue as string | string[], ctx.actor.user.id, today, zone);
      } catch {
        after = [];
      }
    }
    if (pf.required && !pf.condition && !after.length) {
      problem(keyedProblem({ message: `${f.name} is required in ${target.key}`, hint: `Give ${f.name} a value.` }, 'move.fieldRequired', { field: f.name, project: target.key }));
      continue;
    }
    if (after.length) values.set(f.id, after);
    if (before.length || after.length) carried.push({ field: f.name, from: presentValues(s, f, before), to: presentValues(s, f, after) });
  }
  for (const k of given.keys()) {
    if (!pfs.some((pf) => s.fields.get(pf.fieldId)?.name.toLowerCase() === k)) problems.push(keyedProblem({ field: k, message: `${target.key} has no field "${k}"` }, 'move.noField', { project: target.key, field: k }));
  }
  const droppedValues = [...current.entries()]
    .filter(([fid, vals]) => vals.length && !pfs.some((pf) => pf.fieldId === fid))
    .flatMap(([fid, vals]) => (s.fields.get(fid) ? [{ field: s.fields.get(fid)!.name, from: presentValues(s, s.fields.get(fid)!, vals) }] : []));
  const res = await db.execute(
    sql`SELECT sp.id, sp.name FROM sprint_issues si JOIN sprints sp ON sp.id = si.sprint_id JOIN boards b ON b.id = sp.board_id
        WHERE si.issue_id = ${issue.id} AND NOT (${target.id} = ANY(b.project_ids)) ORDER BY sp.name`,
  );
  const sprints = (res as unknown as { rows: { id: string; name: string }[] }).rows;
  const [next] = await db.select({ n: projects.nextNumber }).from(projects).where(eq(projects.id, target.id));
  return {
    s,
    target,
    values,
    leaving: sprints.map((r) => r.id),
    droppedValues,
    plan: {
      from,
      to: `${target.key}-${next?.n ?? 1}`,
      project: { key: target.key, name: target.name },
      problems,
      carried,
      dropped: droppedValues.map((d) => d.field),
      leftSprints: sprints.map((r) => r.name),
      moved: false,
    },
  };
}

function problemList(problems: MoveProblem[]): string {
  return problems.map((p) => (p.choices?.length ? `${p.message} (choose: ${p.choices.join(', ')})` : p.message)).join('; ');
}

export async function moveIssue(ctx: Ctx, idOrReadable: string, input: MoveIssueInput): Promise<MovePlan> {
  requireScope(ctx, 'write');
  const found = await resolveIssue(ctx, idOrReadable);
  if (input.dryRun) return (await planMove(ctx, ctx.db, found, input)).plan;
  const { plan, activity } = await ctx.db.transaction(async (txRaw) => {
    const tx = txRaw as unknown as Db;
    const [issue] = await tx.select().from(issues).where(eq(issues.id, found.id)).for('update');
    if (!issue) throw notFound(`Issue ${idOrReadable}`).said('notFound.issue', { id: idOrReadable });
    const p = await planMove(ctx, tx, issue, input);
    const { s, target } = p;
    if (input.expectedVersion !== undefined && input.expectedVersion !== issue.version) {
      throw conflict(`${p.plan.from} was changed by someone else (version ${issue.version}, you sent ${input.expectedVersion})`, 'Reload the issue and move it again.', {
        currentVersion: issue.version,
      }).said('move.changedMeanwhile', { issue: p.plan.from, version: issue.version, expectedVersion: input.expectedVersion });
    }
    if (p.plan.problems.length) {
      throw badRequest(`${p.plan.from} can't move to ${target.key} yet: ${problemList(p.plan.problems)}`, 'Give a value for each in fields, or null to leave it empty, and move it again.', p.plan).said('move.fieldsToGive', { issue: p.plan.from, project: target.key, problems: saidProblems(p.plan.problems) });
    }
    const [{ number, key: targetKey } = { number: 0, key: target.key }] = await tx
      .update(projects)
      .set({ nextNumber: sql`${projects.nextNumber} + 1` })
      .where(eq(projects.id, target.id))
      .returning({ number: sql<number>`${projects.nextNumber} - 1`, key: projects.key });
    // Its key as it is now, should the project have been renamed while this waited for its row (D52).
    const to = `${targetKey}-${Number(number)}`;
    await tx.insert(issueAliases).values({ projectId: issue.projectId, number: issue.number, issueId: issue.id, movedById: ctx.actor.user.id });
    await tx.delete(issueFieldValues).where(eq(issueFieldValues.issueId, issue.id));
    const rows = [...p.values.entries()].flatMap(([fieldId, vals]) => vals.map((v) => ({ issueId: issue.id, fieldId, ...valueRow(v) })));
    if (rows.length) await tx.insert(issueFieldValues).values(rows);
    const resolved = [...p.values.entries()].some(([fid, vals]) => s.fields.get(fid)?.type === 'state' && vals.some((v) => (v.valueId ? s.values.get(v.valueId)?.isResolved : false)));
    const [moved] = await tx
      .update(issues)
      .set({
        projectId: target.id,
        number: Number(number),
        resolvedAt: resolved ? (issue.resolvedAt ?? new Date()) : null,
        updatedAt: new Date(),
        updatedById: ctx.actor.user.id,
        version: sql`${issues.version} + 1`,
      })
      .where(eq(issues.id, issue.id))
      .returning();
    if (p.leaving.length) await tx.delete(sprintIssues).where(and(eq(sprintIssues.issueId, issue.id), inArray(sprintIssues.sprintId, p.leaving)));
    // What named it by its old id names its new one, and what it says counts where it is now.
    await tx.execute(
      sql`DELETE FROM mentions m WHERE m.target_kind = 'issue' AND m.target = ${p.plan.from}
          AND EXISTS (SELECT 1 FROM mentions x WHERE x.source_type = m.source_type AND x.source_id = m.source_id AND x.target = ${to})`,
    );
    await tx.update(mentions).set({ target: to }).where(and(eq(mentions.targetKind, 'issue'), eq(mentions.target, p.plan.from)));
    await tx.update(mentions).set({ projectId: target.id }).where(eq(mentions.issueId, issue.id));
    const states = await stateNames(tx, s, [issue.id]);
    const from = s.projects.get(issue.projectId)!;
    const changed = p.plan.carried.filter((c) => c.from !== c.to);
    const activity = await recordActivity(tx, ctx, {
      type: 'issue.moved',
      projectId: target.id,
      issueId: issue.id,
      payload: {
        issue: issueRef(s, moved!, states.get(issue.id) ?? null),
        changes: [{ field: 'Project', from: from.key, to: target.key }, ...changed, ...p.droppedValues.map((d) => ({ field: d.field, from: d.from, to: null }))],
        data: { from: p.plan.from, to, fromProject: from.key, toProject: targetKey, ...(p.plan.leftSprints.length ? { leftSprints: p.plan.leftSprints } : {}) },
      },
    });
    return { plan: { ...p.plan, to, moved: true }, activity };
  });
  await publishActivities(ctx.app, [activity]);
  return plan;
}

/** A copy of an issue, in its project or another, linked back to it ("clones"). */
export async function cloneIssue(ctx: Ctx, idOrReadable: string, input: CloneIssueInput): Promise<IssueDetail> {
  requireScope(ctx, 'write');
  const s = await ctx.app.schema.get();
  const source = await resolveIssue(ctx, idOrReadable);
  const sourceProject = s.projects.get(source.projectId)!;
  const target = input.project ? (projectByKey(s, input.project) ?? null) : sourceProject;
  // An unknown or hidden project: createIssue says which ones the caller can file in.
  const values = new Map<string, ResolvedValue[]>();
  if (target) {
    const current = await fieldValuesOf(ctx.db, source.id);
    for (const pf of s.projectFields.get(target.id) ?? []) {
      const f = s.fields.get(pf.fieldId);
      const before = f ? current.get(f.id) : undefined;
      if (!f || !before?.length) continue;
      // What doesn't carry over is left to the other project's defaults.
      const c = target.id === source.projectId ? { values: before } : await carryValues(ctx.db, s, f, target, before);
      if (c.values?.length) values.set(f.id, c.values);
    }
  }
  const tagRows = await ctx.db.select({ name: tags.name }).from(issueTags).innerJoin(tags, eq(tags.id, issueTags.tagId)).where(eq(issueTags.issueId, source.id));
  const aggregation = s.linkTypes.filter((t) => t.aggregation).map((t) => t.id);
  const [parentLink] = aggregation.length
    ? await ctx.db
        .select({ id: issueLinks.sourceId })
        .from(issueLinks)
        .where(and(eq(issueLinks.targetId, source.id), inArray(issueLinks.typeId, aggregation)))
    : [];
  const parentRef = parentLink ? (await issueRefsById(ctx.db, s, [parentLink.id])).get(parentLink.id) : undefined;
  const parentRow = parentRef ? await ctx.db.select({ projectId: issues.projectId }).from(issues).where(eq(issues.id, parentLink!.id)) : [];
  const parent = parentRef && parentRow[0] && (await canReadProject(ctx, parentRow[0].projectId)) ? parentRef.id : undefined;
  const clones = s.linkPhrases.find((p) => p.type.name === CLONE_LINK.name && p.direction === 'outward');
  const original = readableId(s, source);
  return createIssue(
    ctx,
    {
      project: target?.key ?? input.project ?? sourceProject.key,
      summary: input.summary ?? source.summary,
      description: source.description,
      tags: tagRows.map((t) => t.name),
      ...(parent ? { parent } : {}),
      // A copy says what its source says, so it's seen by whom its source is (D37); its cloner, its
      // reporter, still sees it.
      ...(source.limited
        ? { visibleTo: { users: source.visibleUserIds.flatMap((id) => s.users.get(id)?.login ?? []), groups: source.visibleGroupIds } }
        : {}),
      links: clones ? [{ relation: clones.phrase, issue: original }] : [],
    },
    { carry: [...values.entries()].map(([fid, vals]) => ({ field: s.fields.get(fid)!, values: vals })), data: { clonedFrom: original } },
  );
}

import {
  WELL_KNOWN_FIELDS,
  type HelpdeskSettings,
  type TimeSettings,
  type PlanSettings,
  type Project,
  type ProjectAccess,
  type ProjectSettings,
  type ProjectVisibility,
  type TriageMode,
} from '@a4a/shared';
import { eq, sql } from 'drizzle-orm';
import { requireScope, type Ctx } from '../context';
import type { Db } from '../db/client';
import { issues, projectFields, projects } from '../db/schema';
import { publishActivities, recordActivity, type ActivityRow } from '../events/activity';
import { badRequest, notFound } from '../lib/errors';
import { calendarOf } from '../helpdesk/business-time';
import { checkDeskSignIn } from './portal-sign-in';
import { newId } from '../lib/ids';
import { accessChanged, issueSeenSql, projectAccess, requireProject, type AccessView } from './access';
import { isUniqueViolation, keyHolders } from './project-keys';
import { getSetting } from './settings';
import { resyncOpen } from './sla';
import { fieldByName, findUser, projectByKey, type ProjectRow, type SchemaSnapshot } from './schema-cache';
import { userRefDto } from './values';

export const DEFAULT_PLAN: PlanSettings = {
  startDate: null,
  workingDays: [1, 2, 3, 4, 5],
  hoursPerDay: 8,
  holidays: [],
  budget: null,
  currency: 'USD',
};

/** A help desk is off until a manager of the project turns it on (services/helpdesk.ts). */
export const DEFAULT_HELPDESK: HelpdeskSettings = {
  enabled: false,
  firstResponseHours: null,
  intro: '',
  captcha: false,
  businessHours: null,
  waitingStates: [],
  resumeState: null,
  // Requesters sign in to the portal by a link emailed to them, as before D63.
  signIn: { link: true, password: false, providers: [] },
};

/** Work types are offered, not required, until a manager of the project says so (D43). */
export const DEFAULT_TIME: TimeSettings = { workTypeRequired: false };

export function projectSettings(row: ProjectRow): ProjectSettings {
  const raw = (row.settings ?? {}) as Partial<ProjectSettings>;
  return {
    triageMode: (raw.triageMode as TriageMode) ?? 'suggest',
    plan: { ...DEFAULT_PLAN, ...(raw.plan ?? {}) },
    helpdesk: { ...DEFAULT_HELPDESK, ...(raw.helpdesk ?? {}) },
    time: { ...DEFAULT_TIME, ...(raw.time ?? {}) },
  };
}

type Template = 'software' | 'waterfall' | 'blank';

const TEMPLATE_FIELDS: Record<Template, { name: string; required?: boolean; defaultValue?: string }[]> = {
  software: [
    { name: WELL_KNOWN_FIELDS.state, required: true, defaultValue: 'Open' },
    { name: WELL_KNOWN_FIELDS.priority, required: true, defaultValue: 'Normal' },
    { name: WELL_KNOWN_FIELDS.type, required: true, defaultValue: 'Task' },
    { name: WELL_KNOWN_FIELDS.assignee },
    { name: WELL_KNOWN_FIELDS.subsystem },
    { name: WELL_KNOWN_FIELDS.fixVersions },
    { name: WELL_KNOWN_FIELDS.estimation },
    { name: WELL_KNOWN_FIELDS.dueDate },
  ],
  waterfall: [
    { name: WELL_KNOWN_FIELDS.state, required: true, defaultValue: 'Open' },
    { name: WELL_KNOWN_FIELDS.priority, required: true, defaultValue: 'Normal' },
    { name: WELL_KNOWN_FIELDS.type, required: true, defaultValue: 'Task' },
    { name: WELL_KNOWN_FIELDS.assignee },
    { name: WELL_KNOWN_FIELDS.estimation },
    { name: WELL_KNOWN_FIELDS.startDate },
    { name: WELL_KNOWN_FIELDS.dueDate },
    { name: WELL_KNOWN_FIELDS.fixedCost },
    { name: WELL_KNOWN_FIELDS.subsystem },
  ],
  blank: [{ name: WELL_KNOWN_FIELDS.state, required: true, defaultValue: 'Open' }, { name: WELL_KNOWN_FIELDS.assignee }],
};

/** How many issues each project has, and how many are open, that the caller sees (D37: limited ones only where they see them). */
async function counts(ctx: Ctx, view: AccessView): Promise<Map<string, { total: number; open: number }>> {
  const seen = issueSeenSql(view, await ctx.app.schema.get());
  const rows = await ctx.db
    .select({
      projectId: issues.projectId,
      total: sql<number>`count(*)::int`,
      open: sql<number>`count(*) filter (where ${issues.resolvedAt} is null)::int`,
    })
    .from(issues)
    .where(seen)
    .groupBy(issues.projectId);
  return new Map(rows.map((r) => [r.projectId, { total: Number(r.total), open: Number(r.open) }]));
}

export function projectVisibility(row: ProjectRow): ProjectVisibility {
  return row.visibility === 'members' ? 'members' : 'open';
}

const NO_ACCESS: ProjectAccess = { role: 'viewer', roleName: 'Viewer', via: 'open', permissions: [], read: false, comment: false, write: false, manage: false };

/** A project as the caller sees it, with what they may do in it. */
export function projectDto(s: SchemaSnapshot, row: ProjectRow, view: AccessView, c?: { total: number; open: number }): Project {
  const lead = row.leadId ? s.users.get(row.leadId) : undefined;
  return {
    id: row.id,
    key: row.key,
    name: row.name,
    description: row.description,
    lead: lead ? userRefDto(lead) : null,
    archived: row.archived,
    visibility: projectVisibility(row),
    settings: projectSettings(row),
    issueCount: c?.total ?? 0,
    openIssueCount: c?.open ?? 0,
    createdAt: row.createdAt.toISOString(),
    access: view.describe(row.id) ?? NO_ACCESS,
    guestAccess: row.guestAccess,
    formerKeys: s.formerKeys.get(row.id) ?? [],
  };
}

export async function listProjects(ctx: Ctx): Promise<Project[]> {
  requireScope(ctx, 'read');
  const s = await ctx.app.schema.get();
  const view = await projectAccess(ctx);
  const c = await counts(ctx, view);
  const out: Project[] = [];
  for (const p of s.projects.values()) if (view.canRead(p.id)) out.push(projectDto(s, p, view, c.get(p.id)));
  return out;
}

export async function getProject(ctx: Ctx, key: string): Promise<Project> {
  const p = await requireProject(ctx, key);
  const s = await ctx.app.schema.get();
  const view = await projectAccess(ctx);
  const c = await counts(ctx, view);
  return projectDto(s, p, view, c.get(p.id));
}

export async function createProject(
  ctx: Ctx,
  input: { key: string; name: string; description?: string; lead?: string; template?: Template; plan?: Partial<PlanSettings>; visibility?: ProjectVisibility },
): Promise<Project> {
  requireScope(ctx, 'admin');
  const s = await ctx.app.schema.get();
  const key = input.key.toUpperCase();
  if (projectByKey(s, key)) throw badRequest(`Project key ${key} is already used`).said('projects.keyTaken', { key });
  const lead = input.lead ? findUser(s, input.lead, ctx.actor.user.id) : ctx.actor.user;
  if (input.lead && !lead) throw notFound(`User ${input.lead}`).said('notFound.user', { id: input.lead });
  const defaultTriage = ((await getSetting(ctx.db, 'defaultTriageMode')) as TriageMode | undefined) ?? 'suggest';
  const id = newId();
  const settings: ProjectSettings = { triageMode: defaultTriage, plan: { ...DEFAULT_PLAN, ...(input.plan ?? {}) }, helpdesk: DEFAULT_HELPDESK, time: DEFAULT_TIME };
  const keyTaken = () => badRequest(`Project key ${key} is already used`).said('projects.keyTaken', { key });
  await ctx.db.transaction(async (txRaw) => {
    const tx = txRaw as unknown as Db;
    // A key a project had before it was renamed stays its own (D52), as its key now does; read here,
    // not from the cache, so a rename that just committed elsewhere counts. A project taking the key
    // at the same moment meets this one's row on the key's unique index.
    const holders = await keyHolders(tx, key);
    if (holders.now || holders.before) throw keyTaken();
    await tx.insert(projects).values({
      id,
      key,
      name: input.name,
      description: input.description ?? '',
      leadId: lead?.id ?? null,
      visibility: input.visibility ?? 'open',
      settings,
    });
    let ordinal = 0;
    for (const tf of TEMPLATE_FIELDS[input.template ?? 'software']) {
      const field = fieldByName(s, tf.name);
      if (!field) continue;
      await tx.insert(projectFields).values({
        projectId: id,
        fieldId: field.id,
        ordinal: ordinal++,
        required: tf.required ?? false,
        defaultValue: (tf.defaultValue ?? null) as never,
      });
    }
  }).catch((e: unknown) => {
    throw isUniqueViolation(e) ? keyTaken() : e;
  });
  ctx.app.schema.invalidate();
  accessChanged(ctx.app);
  return getProject(ctx, key);
}

export async function updateProject(
  ctx: Ctx,
  key: string,
  input: {
    name?: string;
    description?: string;
    lead?: string | null;
    archived?: boolean;
    visibility?: ProjectVisibility;
    guestAccess?: boolean;
    settings?: { triageMode?: TriageMode; plan?: Partial<PlanSettings>; helpdesk?: Partial<HelpdeskSettings>; time?: Partial<TimeSettings> };
  },
): Promise<Project> {
  // A project's settings are its managers' (and administrators') to change.
  const p = await requireProject(ctx, key, 'manage');
  const s = await ctx.app.schema.get();
  let leadId: string | null | undefined;
  if (input.lead === null) leadId = null;
  else if (input.lead) {
    const u = findUser(s, input.lead, ctx.actor.user.id);
    if (!u) throw notFound(`User ${input.lead}`).said('notFound.user', { id: input.lead });
    leadId = u.id;
  }
  const current = projectSettings(p);
  // D45's organizations are customer groups now (D56): a script that still sets them is told where they went.
  const { organizations, ...helpdesk } = (input.settings?.helpdesk ?? {}) as Partial<HelpdeskSettings> & { organizations?: string[] };
  if (organizations?.length) {
    throw badRequest('Organizations are customer groups now', `Add each domain to a customer group of the desk: POST /api/v1/projects/${p.key}/customer-groups.`).said('projects.organizationsAreGroups', { project: p.key });
  }
  const settings: ProjectSettings = {
    triageMode: input.settings?.triageMode ?? current.triageMode,
    plan: { ...current.plan, ...(input.settings?.plan ?? {}) },
    helpdesk: { ...current.helpdesk, ...helpdesk },
    time: { ...current.time, ...(input.settings?.time ?? {}) },
  };
  if (settings.plan.workingDays.length === 0) throw badRequest('At least one working day is required').said('projects.workingDayRequired');
  // A desk's working hours must read before they're kept: a 400 says what's wrong with them (D45).
  calendarOf(settings.helpdesk.businessHours);
  // How its requesters sign in (D63): one way at least, providers that exist, none a customer group still signs in through.
  const signIn = helpdesk.signIn ? await checkDeskSignIn(ctx, p, helpdesk.signIn, current.helpdesk.signIn) : null;
  if (signIn) settings.helpdesk.signIn = signIn.next;
  const slaChanged = ['businessHours', 'waitingStates', 'firstResponseHours'].some((k) => input.settings?.helpdesk && k in input.settings.helpdesk);
  const visibility = input.visibility !== undefined && input.visibility !== projectVisibility(p) ? input.visibility : undefined;
  // Opening a project to guests (D37) is an administrator's call, and only an open project can be:
  // one its people alone see isn't for anyone who passes. Closing it to its people closes it to guests.
  let guestAccess = input.guestAccess !== undefined && input.guestAccess !== p.guestAccess ? input.guestAccess : undefined;
  if (guestAccess !== undefined) requireScope(ctx, 'admin');
  if (guestAccess && (visibility ?? projectVisibility(p)) !== 'open') {
    throw badRequest(`Only an open project can be open to guests, and ${p.key} is for its members only`, 'Make it open first, then let guests read it.').said('projects.guestsNeedOpen', { key: p.key });
  }
  if (visibility === 'members' && p.guestAccess) guestAccess = false;
  const activities: ActivityRow[] = [];
  await ctx.db.transaction(async (txRaw) => {
    const tx = txRaw as unknown as Db;
    await tx
      .update(projects)
      .set({
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.description !== undefined ? { description: input.description } : {}),
        ...(leadId !== undefined ? { leadId } : {}),
        ...(input.archived !== undefined ? { archived: input.archived } : {}),
        ...(visibility ? { visibility } : {}),
        ...(guestAccess !== undefined ? { guestAccess } : {}),
        settings,
        updatedAt: new Date(),
      })
      .where(eq(projects.id, p.id));
    if (signIn?.changed) {
      activities.push(await recordActivity(tx, ctx, { type: 'project.portal_sign_in.changed', projectId: p.id, issueId: null, payload: { data: signIn.data } }));
    }
    if (visibility || guestAccess !== undefined) {
      activities.push(
        await recordActivity(tx, ctx, {
          type: 'project.visibility.changed',
          projectId: p.id,
          issueId: null,
          payload: { data: { from: projectVisibility(p), to: visibility ?? projectVisibility(p), ...(guestAccess !== undefined ? { guests: guestAccess } : {}) } },
        }),
      );
    }
  });
  ctx.app.schema.invalidate();
  if (visibility || leadId !== undefined || guestAccess !== undefined) accessChanged(ctx.app);
  await publishActivities(ctx.app, activities);
  // Its open requests' clocks follow new hours, waiting states or targets now (D45).
  if (slaChanged) await resyncOpen(ctx.app, p.id);
  return getProject(ctx, key);
}

export async function deleteProject(ctx: Ctx, key: string): Promise<void> {
  requireScope(ctx, 'admin');
  const s = await ctx.app.schema.get();
  const p = projectByKey(s, key);
  if (!p) throw notFound(`Project ${key}`).said('notFound.project', { id: key });
  await ctx.db.delete(projects).where(eq(projects.id, p.id));
  ctx.app.schema.invalidate();
  accessChanged(ctx.app);
}

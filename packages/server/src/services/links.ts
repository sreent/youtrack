import type { IssueLink, LinkType } from '@tracklet/shared';
import { eq } from 'drizzle-orm';
import { requireScope, type Ctx } from '../context';
import type { Db } from '../db/client';
import { issueLinks, linkTypes } from '../db/schema';
import { publishActivities } from '../events/activity';
import { badRequest, notFound } from '../lib/errors';
import { newId } from '../lib/ids';
import { findIssue } from './issues';
import { applyChanges, issueLinksOf, resolveIssue, resolveLinkPhrase } from './issues';

export async function listLinkTypes(ctx: Ctx): Promise<LinkType[]> {
  const s = await ctx.app.schema.get();
  return s.linkTypes.map((t) => ({
    id: t.id,
    name: t.name,
    outward: t.outward,
    inward: t.inward,
    directed: t.directed,
    aggregation: t.aggregation,
  }));
}

export async function createLinkType(
  ctx: Ctx,
  input: { name: string; outward: string; inward?: string; directed?: boolean },
): Promise<LinkType> {
  requireScope(ctx, 'admin');
  const directed = input.directed ?? true;
  const [row] = await ctx.db
    .insert(linkTypes)
    .values({
      id: newId(),
      name: input.name,
      outward: input.outward,
      inward: directed ? (input.inward ?? input.outward) : input.outward,
      directed,
      aggregation: false,
      ordinal: 100,
    })
    .returning();
  ctx.app.schema.invalidate();
  return { id: row!.id, name: row!.name, outward: row!.outward, inward: row!.inward, directed: row!.directed, aggregation: false };
}

export async function listLinks(ctx: Ctx, issueId: string): Promise<IssueLink[]> {
  requireScope(ctx, 'read');
  const issue = await resolveIssue(ctx, issueId);
  return issueLinksOf(ctx, issue.id);
}

/** Link `issueId` to `other` using a phrase from issueId's point of view ("depends on"). */
export async function linkIssues(
  ctx: Ctx,
  issueId: string,
  relation: string,
  other: string,
  remove = false,
): Promise<IssueLink[]> {
  requireScope(ctx, 'write');
  const s = await ctx.app.schema.get();
  const issue = await resolveIssue(ctx, issueId);
  const target = await findIssue(ctx.db, s, other);
  if (!target) throw notFound(`Issue ${other}`);
  const phrase = resolveLinkPhrase(s, relation);
  const result = await ctx.db.transaction(async (tx) =>
    applyChanges(tx as unknown as Db, ctx, issue, { links: [{ phrase, target, remove }] }),
  );
  if (!result.changes.length && remove) throw badRequest(`${issueId} is not linked that way to ${other}`);
  await publishActivities(ctx.app, result.activities);
  return issueLinksOf(ctx, issue.id);
}

export async function deleteLinkById(ctx: Ctx, linkId: string): Promise<void> {
  requireScope(ctx, 'write');
  const s = await ctx.app.schema.get();
  const [link] = await ctx.db.select().from(issueLinks).where(eq(issueLinks.id, linkId));
  if (!link) throw notFound('Link');
  const type = s.linkTypes.find((t) => t.id === link.typeId);
  if (!type) throw notFound('Link type');
  const source = await resolveIssue(ctx, link.sourceId);
  const target = await resolveIssue(ctx, link.targetId);
  const phrase = s.linkPhrases.find((p) => p.type.id === type.id && (p.direction === 'outward' || p.direction === 'both'))!;
  const result = await ctx.db.transaction(async (tx) =>
    applyChanges(tx as unknown as Db, ctx, source, { links: [{ phrase, target, remove: true }] }),
  );
  await publishActivities(ctx.app, result.activities);
}

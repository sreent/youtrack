/**
 * Commits and pull requests, linked to the issues they mention, and the commands commits give.
 *
 * Each issue a commit mentions is linked in a transaction of its own, which takes the issue's row
 * lock first, as every write to an issue does (so two deliveries linking to one issue serialise
 * instead of deadlocking). A command runs inside it, in a savepoint, as the commit's author in
 * a4a, known by a confirmed email or a login at the provider (authors.ts): if it fails, the link
 * stays and says why.
 */
import type { Change, IssueVcs, NoteSaid, PullRequestState, VcsProvider } from '@a4a/shared';
import { and, desc, eq } from 'drizzle-orm';
import { systemCtx } from '../app-services';
import { commandSpec } from '../commands/executor';
import { parseCommand } from '../commands/parser';
import { requireScope, type AppServices, type Ctx, type UserRow } from '../context';
import type { Db } from '../db/client';
import { issues, vcsIntegrations, vcsLinks } from '../db/schema';
import { publishActivities, recordActivity, type ActivityRow } from '../events/activity';
import { AppError, asSentence, saidProblems } from '../lib/errors';
import { newId } from '../lib/ids';
import { excerpt } from '../lib/text';
import { assertCanWriteProject, publicChanges } from '../services/access';
import { issueRef, readableId, stateNames, type IssueRow } from '../services/issue-refs';
import { applyChanges, findIssue, resolveIssue } from '../services/issues';
import type { SchemaSnapshot } from '../services/schema-cache';
import { userRefDto } from '../services/values';
import type { Author } from './authors';
import { splitMessage } from './mentions';
import type { Commit, Person } from './payloads';

export type IntegrationRow = typeof vcsIntegrations.$inferSelect;
type LinkRow = typeof vcsLinks.$inferSelect;

const BODY_MAX = 4000;

/** Nobody in particular: a change made through an integration rather than as a person. */
export const NOBODY = {
  id: 'system',
  login: 'system',
  name: 'a4a',
  email: null,
  emailVerified: false,
  passwordHash: null,
  role: 'viewer',
  isBot: true,
  avatarColor: '',
  banned: false,
  hourlyRate: null,
  capacityHoursPerDay: 0,
  workWeek: null,
  timeZone: null,
  locale: null,
  createdAt: new Date(0),
  updatedAt: new Date(0),
} satisfies UserRow;

/**
 * Changes made from version control: as the commit's author when a4a knows them (with their own
 * access, as they would sign in), else as nobody, through the integration. Like a token limited to
 * projects, it reaches only the integration's projects, when it lists some.
 */
function vcsCtx(app: AppServices, integration: IntegrationRow, person: UserRow | null): Ctx {
  const ctx = systemCtx(app, person ?? NOBODY, 'vcs');
  ctx.actor.tokenName = integration.name;
  ctx.actor.projectIds = integration.projectIds.length ? [...integration.projectIds] : null;
  return ctx;
}

function changeWords(changes: Change[]): string {
  return changes.map((c) => `${c.field}: ${c.from ?? '—'} → ${c.to ?? '—'}`).join('; ');
}

/** The issue's row lock, before anything is written about it. */
async function lockIssue(tx: Db, issueId: string): Promise<IssueRow | undefined> {
  const [row] = await tx.select().from(issues).where(eq(issues.id, issueId)).for('update');
  return row;
}

async function refOf(tx: Db, s: SchemaSnapshot, issue: IssueRow) {
  const states = await stateNames(tx, s, [issue.id]);
  return issueRef(s, issue, states.get(issue.id) ?? null);
}

export interface CommitOutcome {
  linked: boolean;
  applied: boolean;
  /** For the delivery's log: what happened on this issue, in words. */
  said: string;
}

/** Link one commit to one issue it mentions, and run the command it gave the issue, if it gave one and may. */
export async function linkCommit(
  app: AppServices,
  s: SchemaSnapshot,
  integration: IntegrationRow,
  push: { repository: string; branch: string | null },
  commit: Commit,
  issue: IssueRow,
  command: string | null,
  author: Author,
): Promise<CommitOutcome> {
  const short = commit.sha.slice(0, 7);
  const id = readableId(s, issue);
  const [already] = await app.db
    .select({ id: vcsLinks.id })
    .from(vcsLinks)
    .where(and(eq(vcsLinks.issueId, issue.id), eq(vcsLinks.kind, 'commit'), eq(vcsLinks.repository, push.repository), eq(vcsLinks.ref, commit.sha)))
    .limit(1);
  // A commit comes again when it's pushed to another branch, or a delivery is sent again.
  if (already) return { linked: false, applied: false, said: `${id}: ${short} was linked already` };

  const ctx = vcsCtx(app, integration, author.user);
  // Whether the command may run: as its author, known by a confirmed email or a login, who can change the project's issues.
  let ops: ReturnType<typeof parseCommand>['ops'] | null = null;
  let note: string | null = null;
  // The note in the catalogs, for a page in another language (D49): why it wasn't applied, or that it
  // changed nothing. One that lists the changes is field names and values, and needs no words.
  let noteSaid: NoteSaid | null = null;
  let said = '';
  if (command) {
    const key = s.projects.get(issue.projectId)?.key ?? 'the project';
    if (!author.user) {
      note = `Not applied: ${author.why}`;
      noteSaid = author.whySaid;
      said = `#${command} not applied: ${author.detail}`;
    } else if (!(await canWrite(ctx, issue.projectId))) {
      note = `Not applied: ${author.user.name} can’t change issues in ${key}`;
      noteSaid = { key: 'vcs.why.cantChange', values: { name: author.user.name, project: key } };
      said = `#${command} not applied: ${author.user.name} can’t change issues in ${key}`;
    } else {
      const parsed = parseCommand(command, s, [issue.projectId]);
      if (parsed.problems.length) {
        note = `Not applied: ${parsed.problems.map((p) => (p.hint ? `${p.message} (${p.hint})` : p.message)).join('; ')}`;
        noteSaid = { key: 'problem.vcs.commandProblems', values: { problems: saidProblems(parsed.problems) } };
        said = `#${command} ${note.charAt(0).toLowerCase()}${note.slice(1)}`;
      } else ops = parsed.ops;
    }
  }

  const { title, body } = splitMessage(commit.message);
  let applied = false;
  const activities: ActivityRow[] = [];
  const linked = await app.db.transaction(async (txRaw) => {
    const tx = txRaw as unknown as Db;
    const locked = await lockIssue(tx, issue.id);
    if (!locked) return false;
    const [row] = await tx
      .insert(vcsLinks)
      .values({
        id: newId(),
        integrationId: integration.id,
        issueId: issue.id,
        kind: 'commit',
        repository: push.repository,
        ref: commit.sha,
        title: excerpt(title, 500) || short,
        body: excerpt(body, BODY_MAX),
        url: commit.url,
        branch: push.branch,
        authorName: commit.author.name,
        authorLogin: commit.author.login,
        authorEmail: commit.author.email,
        authorId: author.user?.id ?? null,
        command,
        happenedAt: commit.at,
      })
      .onConflictDoNothing()
      .returning();
    if (!row) return false;
    if (ops) {
      try {
        // In a savepoint: a command that fails (a guard refuses it, a value is gone) leaves the link.
        const res = await tx.transaction(async (spRaw) => {
          const sp = spRaw as unknown as Db;
          const spec = await commandSpec(ctx, locked, ops!, undefined, { db: sp });
          return applyChanges(sp, ctx, locked, spec);
        });
        activities.push(...res.activities);
        applied = true;
        // The note shows to everyone who reads the issue: a private field's change isn't in it (D50).
        const shown = publicChanges(s, locked.projectId, res.changes);
        note = shown.length ? changeWords(shown) : 'Nothing to change: it was so already';
        noteSaid = shown.length ? null : { key: 'vcs.note.nothingToChange' };
        said = `#${command} applied as ${author.user!.name}: ${note}`;
      } catch (e) {
        if (!(e instanceof AppError)) throw e;
        note = `Not applied: ${e.message}`;
        noteSaid = e.words ? { key: `problem.${e.words.key}`, ...(e.words.values ? { values: e.words.values } : {}) } : { key: 'problem.inItsOwnWords', values: { words: asSentence(e.message) } };
        said = `#${command} not applied: ${e.message}`;
      }
      await tx.update(vcsLinks).set({ commandApplied: applied, commandNote: note, commandSaid: noteSaid }).where(eq(vcsLinks.id, row.id));
    } else if (command) {
      await tx.update(vcsLinks).set({ commandApplied: false, commandNote: note, commandSaid: noteSaid }).where(eq(vcsLinks.id, row.id));
    }
    const now = (await findIssue(tx, s, issue.id)) ?? locked;
    activities.push(
      await recordActivity(tx, ctx, {
        type: 'commit.linked',
        projectId: issue.projectId,
        issueId: issue.id,
        payload: {
          issue: await refOf(tx, s, now),
          data: {
            repository: push.repository,
            sha: commit.sha,
            title: row.title,
            url: commit.url,
            branch: push.branch,
            author: commit.author.name ?? commit.author.login,
            ...(command ? { command, applied, note, ...(noteSaid ? { said: noteSaid } : {}) } : {}),
          },
        },
      }),
    );
    return true;
  });
  await publishActivities(app, activities);
  if (!linked) return { linked: false, applied: false, said: `${id}: ${short} was linked already` };
  return { linked: true, applied, said: `${id}: linked ${short}${said ? `; ${said}` : ''}` };
}

/** Through the access seam, so per-project roles decide it too. */
async function canWrite(ctx: Ctx, projectId: string): Promise<boolean> {
  try {
    await assertCanWriteProject(ctx, projectId);
    return true;
  } catch (e) {
    if (e instanceof AppError) return false;
    throw e;
  }
}

export interface PullRequestFacts {
  repository: string;
  number: number;
  title: string;
  body: string;
  url: string | null;
  branch: string | null;
  target: string | null;
  state: PullRequestState;
  author: Person;
  at: Date | null;
}

/**
 * Keep a pull request's links current: those it has take its state, title and branches as they
 * are now (a change of state is recorded on each issue), and issues it mentions for the first time
 * are linked, with its author in a4a when a4a knows them (D33). Who opened it isn't who changes
 * its state, so linking stays the integration's doing, not the author's.
 */
export async function syncPullRequest(
  app: AppServices,
  s: SchemaSnapshot,
  integration: IntegrationRow,
  pr: PullRequestFacts,
  mentioned: IssueRow[],
  authorId: string | null = null,
): Promise<{ linked: number; changed: number; said: string[] }> {
  const ref = String(pr.number);
  const ctx = vcsCtx(app, integration, null);
  const existing = await app.db
    .select()
    .from(vcsLinks)
    .where(and(eq(vcsLinks.kind, 'pull_request'), eq(vcsLinks.repository, pr.repository), eq(vcsLinks.ref, ref)));
  const said: string[] = [];
  let changed = 0;
  let linked = 0;
  const facts = {
    title: excerpt(pr.title, 500),
    body: excerpt(pr.body, BODY_MAX),
    url: pr.url,
    branch: pr.branch,
    targetBranch: pr.target,
    state: pr.state,
    happenedAt: pr.at,
  };
  const data = (row: Pick<LinkRow, 'state'> | null) => ({
    repository: pr.repository,
    number: pr.number,
    title: facts.title,
    url: pr.url,
    branch: pr.branch,
    target: pr.target,
    state: pr.state,
    ...(row && row.state !== pr.state ? { from: row.state } : {}),
    author: pr.author.login ?? pr.author.name,
  });

  for (const row of existing) {
    const stale = row.state !== pr.state || row.title !== facts.title || row.branch !== pr.branch || row.targetBranch !== pr.target || row.url !== pr.url;
    if (!stale) continue;
    const activities: ActivityRow[] = [];
    const issueKey = await app.db.transaction(async (txRaw) => {
      const tx = txRaw as unknown as Db;
      const locked = await lockIssue(tx, row.issueId);
      if (!locked) return null;
      await tx.update(vcsLinks).set({ ...facts, updatedAt: new Date() }).where(eq(vcsLinks.id, row.id));
      // Its state is what people follow; a new title or branch alone isn't worth a line in history.
      if (row.state !== pr.state) {
        activities.push(
          await recordActivity(tx, ctx, {
            type: 'pull_request.updated',
            projectId: locked.projectId,
            issueId: locked.id,
            payload: { issue: await refOf(tx, s, locked), data: data(row) },
          }),
        );
      }
      return readableId(s, locked);
    });
    await publishActivities(app, activities);
    if (!issueKey) continue;
    changed++;
    said.push(`${issueKey}: #${pr.number} ${row.state !== pr.state ? `is ${pr.state} now` : 'brought up to date'}`);
  }

  const linkedAlready = new Set(existing.map((r) => r.issueId));
  for (const issue of mentioned) {
    if (linkedAlready.has(issue.id)) continue;
    const activities: ActivityRow[] = [];
    const made = await app.db.transaction(async (txRaw) => {
      const tx = txRaw as unknown as Db;
      const locked = await lockIssue(tx, issue.id);
      if (!locked) return false;
      const [row] = await tx
        .insert(vcsLinks)
        .values({
          id: newId(),
          integrationId: integration.id,
          issueId: issue.id,
          kind: 'pull_request',
          repository: pr.repository,
          ref,
          ...facts,
          authorName: pr.author.name,
          authorLogin: pr.author.login,
          authorId,
        })
        .onConflictDoNothing()
        .returning({ id: vcsLinks.id });
      if (!row) return false;
      activities.push(
        await recordActivity(tx, ctx, {
          type: 'pull_request.linked',
          projectId: locked.projectId,
          issueId: locked.id,
          payload: { issue: await refOf(tx, s, locked), data: data(null) },
        }),
      );
      return true;
    });
    await publishActivities(app, activities);
    if (made) {
      linked++;
      said.push(`${readableId(s, issue)}: linked #${pr.number} (${pr.state})`);
    }
  }
  return { linked, changed, said };
}

// ---------------------------------------------------------------------------
// Reading: an issue's commits and pull requests
// ---------------------------------------------------------------------------

export async function issueVcs(ctx: Ctx, idOrReadable: string): Promise<IssueVcs> {
  requireScope(ctx, 'read');
  const issue = await resolveIssue(ctx, idOrReadable);
  const s = await ctx.app.schema.get();
  const rows = await ctx.db
    .select({ link: vcsLinks, source: { id: vcsIntegrations.id, name: vcsIntegrations.name, provider: vcsIntegrations.provider } })
    .from(vcsLinks)
    .leftJoin(vcsIntegrations, eq(vcsIntegrations.id, vcsLinks.integrationId))
    .where(eq(vcsLinks.issueId, issue.id))
    .orderBy(desc(vcsLinks.happenedAt), desc(vcsLinks.createdAt))
    .limit(200);
  const out: IssueVcs = { commits: [], pullRequests: [] };
  for (const { link, source } of rows) {
    const user = link.authorId ? s.users.get(link.authorId) : undefined;
    const author = { name: link.authorName, login: link.authorLogin, user: user ? userRefDto(user) : null };
    const integration = source?.id ? { id: source.id, name: source.name!, provider: source.provider as VcsProvider } : null;
    const at = (link.happenedAt ?? link.createdAt).toISOString();
    if (link.kind === 'commit') {
      out.commits.push({
        id: link.id,
        repository: link.repository,
        sha: link.ref,
        title: link.title,
        body: link.body,
        url: link.url,
        branch: link.branch,
        author,
        at,
        command: link.command,
        applied: link.command ? Boolean(link.commandApplied) : null,
        note: link.commandNote,
        said: link.commandSaid ?? null,
        integration,
      });
    } else {
      out.pullRequests.push({
        id: link.id,
        repository: link.repository,
        number: Number(link.ref),
        title: link.title,
        url: link.url,
        state: (link.state as PullRequestState | null) ?? 'open',
        branch: link.branch,
        target: link.targetBranch,
        author,
        at,
        integration,
      });
    }
  }
  return out;
}

/** A notification's email, and the daily digest: rendered when sent, from what is true then. */
import type { IssueRef, NotificationKind } from '@a4a/shared';
import { eq, sql } from 'drizzle-orm';
import { systemCtx } from '../app-services';
import type { AppServices } from '../context';
import { notifications, notificationSettings, users } from '../db/schema';
import { AUTOMATIC, composeMail, threadHeaders, unsubscribeHeaders, type MailSection, type RenderedMail } from '../mail/compose';
import { mailHost, type MailRow } from '../mail/outbox';
import { canReadProject } from '../services/access';
import { digestRows, eventsOf, unsubscribeToken, type UnsubscribeKind } from '../services/notifications';
import { emailPrefs, levelSends } from './notifier';
import { actorName, BECAUSE, emailTime, eventDetail, eventVerb, notificationTitle } from './words';

function links(app: AppServices) {
  const base = app.config.publicUrl;
  return {
    issue: (id: string) => `${base}/issues/${encodeURIComponent(id)}`,
    page: (token: string) => `${base}/unsubscribe?token=${encodeURIComponent(token)}`,
    oneClick: (token: string) => `${base}/api/v1/unsubscribe?token=${encodeURIComponent(token)}`,
    settings: `${base}/me`,
    inbox: `${base}/inbox`,
  };
}

/**
 * One notification's email. It seals the notification first (no more events fold into it, so the
 * email says all it holds), and sends nothing if it was read in the app meanwhile, if the person no
 * longer wants this kind, or can no longer read the project.
 */
export async function renderNotificationMail(app: AppServices, row: MailRow): Promise<RenderedMail | null> {
  const id = String((row.payload as { notificationId?: string }).notificationId ?? '');
  const [n] = await app.db
    .update(notifications)
    .set({ sealedAt: sql`coalesce(${notifications.sealedAt}, now())` })
    .where(eq(notifications.id, id))
    .returning();
  if (!n || n.readAt) return null;
  const [user] = await app.db.select().from(users).where(eq(users.id, n.userId));
  if (!user?.email || user.banned || user.isBot) return null;
  const prefs = await emailPrefs(app.db, n.userId);
  const kind = n.kind as NotificationKind;
  if (!levelSends(prefs.email, kind)) return null;
  if (n.projectId && !(await canReadProject(systemCtx(app, user), n.projectId))) return null;

  const s = await app.schema.get();
  const { events, reasons } = (await eventsOf(app.db, s, [n.id])).get(n.id) ?? { events: [], reasons: new Map() };
  if (!events.length) return null;
  const issue = n.issue as IssueRef;
  const title = notificationTitle(kind, events, reasons);
  const subject = `${issue.id}: ${issue.summary}`;
  const l = links(app);
  const stopKind: UnsubscribeKind = kind === 'watching' ? 'watching' : 'direct';
  const token = await unsubscribeToken(app, stopKind, n.userId);
  const sections: MailSection[] = events.map((e) => {
    const detail = eventDetail(e);
    const quoted = e.type.startsWith('comment') || e.type === 'issue.created';
    return {
      head: `${actorName(e)} ${eventVerb(e)} · ${emailTime(e.occurredAt)}`,
      ...(quoted ? { quote: detail.join('\n') } : { lines: detail }),
    };
  });
  const { text, html } = composeMail(subject, {
    lead: `${title} on ${issue.id}: ${issue.summary}`,
    sections,
    action: n.issueId ? { label: `Open ${issue.id}`, url: l.issue(issue.id) } : { label: 'Open your inbox', url: l.inbox },
    why: `You get this because ${BECAUSE[kind]}.`,
    stop: { label: stopKind === 'watching' ? 'Stop emails about issues you watch' : 'Stop emails about issues', url: l.page(token) },
    settings: { label: 'Choose what a4a emails you', url: l.settings },
  });
  return {
    to: user.email,
    subject,
    text,
    html,
    headers: { ...AUTOMATIC, ...unsubscribeHeaders(l.oneClick(token)), ...(n.issueId ? threadHeaders(`<issue-${n.issueId}@${mailHost(app)}>`) : {}) },
    onSent: async () => {
      await app.db.update(notifications).set({ emailedAt: new Date() }).where(eq(notifications.id, n.id));
    },
  };
}

/** The daily digest: what's still unread and wasn't emailed, by issue. Nothing to say, nothing sent. */
export async function renderDigestMail(app: AppServices, row: MailRow): Promise<RenderedMail | null> {
  const p = row.payload as { userId?: string; since?: string; until?: string };
  const userId = String(p.userId ?? '');
  const since = new Date(p.since ?? 0);
  const until = new Date(p.until ?? Date.now());
  const done = () => app.db.update(notificationSettings).set({ lastDigestAt: until }).where(eq(notificationSettings.userId, userId));
  const [user] = await app.db.select().from(users).where(eq(users.id, userId));
  const prefs = await emailPrefs(app.db, userId);
  if (!user?.email || user.banned || !prefs.digest) return null;
  const ctx = systemCtx(app, user);
  const rows = [];
  for (const r of await digestRows(app.db, userId, since, until)) if (!r.projectId || (await canReadProject(ctx, r.projectId))) rows.push(r);
  if (!rows.length) {
    await done();
    return null;
  }
  const s = await app.schema.get();
  const events = await eventsOf(app.db, s, rows.map((r) => r.id));
  const l = links(app);
  const token = await unsubscribeToken(app, 'digest', userId);
  const byIssue = new Map<string, { issue: IssueRef; lines: string[] }>();
  for (const r of rows) {
    const issue = r.issue as IssueRef;
    const entry = byIssue.get(issue.id) ?? { issue, lines: [] };
    const e = events.get(r.id) ?? { events: [], reasons: new Map() };
    entry.lines.push(`${notificationTitle(r.kind as NotificationKind, e.events, e.reasons)} · ${emailTime(r.lastEventAt.toISOString())}`);
    byIssue.set(issue.id, entry);
  }
  const subject = `Your a4a digest: ${rows.length} unread ${rows.length === 1 ? 'notification' : 'notifications'}`;
  const { text, html } = composeMail(subject, {
    lead: `What happened on ${byIssue.size} ${byIssue.size === 1 ? 'issue' : 'issues'} since your last digest, still unread:`,
    sections: [...byIssue.values()].map((g) => ({ head: `${g.issue.id}: ${g.issue.summary} · ${l.issue(g.issue.id)}`, lines: g.lines })),
    action: { label: 'Open your inbox', url: l.inbox },
    why: 'You get this because you asked for a daily digest.',
    stop: { label: 'Stop the daily digest', url: l.page(token) },
    settings: { label: 'Choose what a4a emails you', url: l.settings },
  });
  return { to: user.email, subject, text, html, headers: { ...AUTOMATIC, ...unsubscribeHeaders(l.oneClick(token)) }, onSent: async () => void (await done()) };
}

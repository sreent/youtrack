/** A notification's email, and the daily digest: rendered when sent, from what is true then. */
import type { IssueRef, NotificationKind } from '@a4a/shared';
import { subscriptionTells } from '@a4a/shared/i18n';
import { eq, inArray, sql } from 'drizzle-orm';
import type { AppServices } from '../context';
import { comments, notifications, notificationSettings, users } from '../db/schema';
import { AUTOMATIC, composeMail, threadHeaders, unsubscribeHeaders, type MailSection, type RenderedMail } from '../mail/compose';
import { mailHost, type MailRow } from '../mail/outbox';
import { accessFor, eventFor, eventSeen } from '../services/access';
import { digestRows, eventsOf, unsubscribeToken, type UnsubscribeKind } from '../services/notifications';
import { aboutSubscriptions } from '../services/subscriptions';
import { forgetTeamReplyAddress, mintTeamReplyAddress } from '../services/team-replies';
import { zoneOfUser } from '../services/time-zones';
import { emailPrefs, emailSends, levelSends } from './notifier';
import { actorName, because, emailTime, eventDetail, eventVerb, notificationTitle } from './words';
import { localeOfPerson, translatorFor } from '../i18n';

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
  const s = await app.schema.get();
  // A subscription that brought it may ask for email of its own (D31), as long as it's still theirs.
  const subscription = n.subscriptionId ? (await aboutSubscriptions(app.db, s, [n.subscriptionId])).get(n.subscriptionId) : undefined;
  const sub = subscription && subscription.userId === n.userId ? { id: n.subscriptionId!, ...subscription } : null;
  if (!emailSends(prefs.email, kind, sub)) return null;
  const byLevel = levelSends(prefs.email, kind);
  // What the person may see now, as they would signing in: the project, and each event in it.
  const view = await accessFor(app.db, user);
  if (!n.projectId || !view.canRead(n.projectId)) return null;

  const { events, reasons } = (await eventsOf(app.db, s, [n.id], { visible: (e) => eventSeen(view, app.db, s, e), shape: (e) => eventFor(view, s, e) })).get(n.id) ?? { events: [], reasons: new Map() };
  if (!events.length) return null;
  const issue = n.issue as IssueRef;
  const tr = translatorFor(localeOfPerson(app, user));
  const title = notificationTitle(tr, kind, events, reasons);
  const subject = `${issue.id}: ${issue.summary}`;
  const l = links(app);
  const zone = zoneOfUser(user);
  // Its stop link stops what sent it: this kind of email, or this subscription's email.
  const stopKind: UnsubscribeKind = !byLevel && sub ? 'subscription' : kind === 'watching' ? 'watching' : 'direct';
  const token = await unsubscribeToken(app, stopKind, stopKind === 'subscription' ? sub!.id : n.userId);
  // A comment as it was written, with its lines, where the event keeps only an excerpt; one deleted since isn't quoted.
  const ids = events.map((e) => (e.type.startsWith('comment') ? (e.data as { commentId?: string }).commentId : undefined)).filter((id): id is string => Boolean(id));
  const written = new Map(
    ids.length ? (await app.db.select({ id: comments.id, text: comments.text, deletedAt: comments.deletedAt }).from(comments).where(inArray(comments.id, ids))).map((c) => [c.id, c]) : [],
  );
  // Their answer to this email is a comment by them (D45), when replies by email are set up and
  // they may comment: public if what they answer was (the requester's message, a public reply).
  const lastComment = [...events].reverse().find((e) => e.type === 'comment.created');
  const replyTo =
    n.issueId && view.canComment(n.projectId)
      ? await mintTeamReplyAddress(app, app.db, user.id, n.issueId, (lastComment?.data as { visibility?: string } | undefined)?.visibility === 'public')
      : null;
  const sections: MailSection[] = events.map((e) => {
    const head = `${actorName(tr, e)} ${eventVerb(tr, e)} · ${emailTime(e.occurredAt, zone, tr.locale)}`;
    if (e.type.startsWith('comment')) {
      const c = written.get(String((e.data as { commentId?: string }).commentId ?? ''));
      if (c?.deletedAt) return { head: tr.t('server.mail.deletedSince', { head }) };
      const text = c ? (c.text.length > 4000 ? `${c.text.slice(0, 3999)}…` : c.text) : eventDetail(tr, e).join('\n');
      return { head, quote: text };
    }
    const detail = eventDetail(tr, e);
    return e.type === 'issue.created' ? { head, quote: detail.join('\n') } : { head, lines: detail };
  });
  const t = tr.t;
  const { text, html } = composeMail(subject, {
    lead: t('server.mail.lead', { title, id: issue.id, summary: issue.summary }),
    sections,
    action: n.issueId ? { label: t('server.mail.open', { id: issue.id }), url: l.issue(issue.id) } : { label: t('server.mail.openInbox'), url: l.inbox },
    why: `${stopKind === 'subscription' ? t('server.mail.whySubscribed', { tells: subscriptionTells(sub!.target, sub!.events), name: sub!.name }) : t('server.mail.why', { because: because(tr, kind) })}${replyTo ? ` ${t('server.mail.replyToComment')}` : ''}`,
    stop: {
      label:
        stopKind === 'subscription'
          ? t('server.mail.stopSubscription', { tells: subscriptionTells(sub!.target, sub!.events), name: sub!.name })
          : stopKind === 'watching'
            ? t('server.mail.stopWatching')
            : t('server.mail.stopIssues'),
      url: l.page(token),
    },
    settings: { label: t('server.mail.settings'), url: l.settings },
  });
  return {
    to: user.email,
    subject,
    text,
    html,
    headers: {
      ...AUTOMATIC,
      ...unsubscribeHeaders(l.oneClick(token)),
      ...(n.issueId ? threadHeaders(`<issue-${n.issueId}@${mailHost(app)}>`) : {}),
      ...(replyTo ? { 'Reply-To': replyTo /* not words: a header */ } : {}),
    },
    onFailed: async () => forgetTeamReplyAddress(app.db, replyTo, app),
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
  const view = await accessFor(app.db, user);
  const rows = (await digestRows(app.db, userId, since, until)).filter((r) => r.projectId && view.canRead(r.projectId));
  if (!rows.length) {
    await done();
    return null;
  }
  const s = await app.schema.get();
  const events = await eventsOf(app.db, s, rows.map((r) => r.id), { visible: (e) => eventSeen(view, app.db, s, e), shape: (e) => eventFor(view, s, e) });
  const l = links(app);
  const token = await unsubscribeToken(app, 'digest', userId);
  const tr = translatorFor(localeOfPerson(app, user));
  const t = tr.t;
  const byIssue = new Map<string, { issue: IssueRef; lines: string[] }>();
  for (const r of rows) {
    const issue = r.issue as IssueRef;
    const e = events.get(r.id) ?? { events: [], reasons: new Map() };
    // Nothing in it they may see now (an issue limited away from them, D37): not theirs to read of.
    if (!e.events.length) continue;
    const entry = byIssue.get(issue.id) ?? { issue, lines: [] };
    entry.lines.push(`${notificationTitle(tr, r.kind as NotificationKind, e.events, e.reasons)} · ${emailTime(r.lastEventAt.toISOString(), zoneOfUser(user), tr.locale)}`);
    byIssue.set(issue.id, entry);
  }
  if (!byIssue.size) {
    await done();
    return null;
  }
  const subject = t('server.mail.digest.subject', { n: rows.length });
  const { text, html } = composeMail(subject, {
    lead: t('server.mail.digest.lead', { n: byIssue.size }),
    sections: [...byIssue.values()].map((g) => ({ head: `${g.issue.id}: ${g.issue.summary} · ${l.issue(g.issue.id)}`, lines: g.lines })),
    action: { label: t('server.mail.openInbox'), url: l.inbox },
    why: t('server.mail.digest.why'),
    stop: { label: t('server.mail.digest.stop'), url: l.page(token) },
    settings: { label: t('server.mail.settings'), url: l.settings },
  });
  return { to: user.email, subject, text, html, headers: { ...AUTOMATIC, ...unsubscribeHeaders(l.oneClick(token)) }, onSent: async () => void (await done()) };
}

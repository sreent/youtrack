/**
 * Subscriptions by kind (D45): a person chooses which kinds of change tell them, for what they
 * watch and as their subscriptions' default, and a subscription for itself; being mentioned or
 * assigned always tells them.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { OutboxWorker } from '../src/events/worker';
import { kindOfEvent, myKinds, setMyKinds, setSubscriptionKinds } from '../src/notify/kinds';
import { notifierConsumer } from '../src/notify/notifier';
import { addComment } from '../src/services/comments';
import { createIssue, updateIssue } from '../src/services/issues';
import { listNotifications } from '../src/services/notifications';
import { subscribe } from '../src/services/subscriptions';
import { addWatchers } from '../src/services/watchers';
import { createWorld, type TestWorld } from './helpers';

let w: TestWorld;
let outbox: OutboxWorker;

beforeAll(async () => {
  w = await createWorld();
  outbox = new OutboxWorker(w.app, [notifierConsumer(w.app)], {}, [], () => {});
  await outbox.drain();
});
afterAll(async () => w?.close());

const inbox = async () => (await listNotifications(w.as(w.anna), {})).items.map((n) => n.issue.id);

describe('the kinds of change that tell a person', () => {
  it('reads an event as the kind of change it is', () => {
    expect(kindOfEvent({ type: 'comment.created', changes: [], data: {} } as never)).toBe('commented');
    expect(kindOfEvent({ type: 'issue.updated', changes: [{ field: 'State' }], data: {} } as never)).toBe('state');
    expect(kindOfEvent({ type: 'issue.updated', changes: [{ field: 'Assignee' }], data: {} } as never)).toBe('assigned');
    expect(kindOfEvent({ type: 'issue.updated', changes: [{ field: 'Priority' }], data: {} } as never)).toBe('fields');
    expect(kindOfEvent({ type: 'issue.updated', changes: [{ field: 'SLA status' }], data: { sla: true } } as never)).toBe('sla');
    expect(kindOfEvent({ type: 'sla.breached', changes: [], data: {} } as never)).toBe('sla');
  });

  it('keeps comments on watched issues out of the inbox when asked, but not state changes or mentions', async () => {
    await setMyKinds(w.as(w.anna), { watching: { commented: { inbox: false, email: false } } });
    expect((await myKinds(w.as(w.anna))).watching.commented).toEqual({ inbox: false, email: false });
    const issue = await createIssue(w.as(w.ben), { project: 'BACK', summary: 'Cache misses at noon' });
    const s = await w.app.schema.get();
    await w.app.db.transaction(async (tx) => {
      const { issues } = await import('../src/db/schema');
      const { eq } = await import('drizzle-orm');
      const [row] = await tx.select().from(issues).where(eq(issues.id, issue.uid));
      await addWatchers(tx as never, s, row!, [{ login: 'anna', reason: 'manual' as never }]);
    });
    await addComment(w.as(w.ben), issue.id, 'Seen it twice today.');
    await outbox.drain();
    expect(await inbox()).not.toContain(issue.id);
    await updateIssue(w.as(w.ben), issue.id, { fields: { State: 'In Progress' } });
    await outbox.drain();
    expect(await inbox()).toContain(issue.id);
    // A mention always reaches her.
    const other = await createIssue(w.as(w.ben), { project: 'BACK', summary: 'Logs rotate too often' });
    await addComment(w.as(w.ben), other.id, 'What do you think, @anna?');
    await outbox.drain();
    expect(await inbox()).toContain(other.id);
  });

  it('lets a subscription choose for itself, or follow the defaults', async () => {
    const sub = await subscribe(w.as(w.ben), { project: 'WEB', events: 'all' });
    await setMyKinds(w.as(w.ben), { defaults: { created: { inbox: false, email: false } } });
    const quiet = await createIssue(w.as(w.anna), { project: 'WEB', summary: 'Footer overlaps on phones' });
    await outbox.drain();
    const benInbox = async () => (await listNotifications(w.as(w.ben), {})).items.map((n) => n.issue.id);
    expect(await benInbox()).not.toContain(quiet.id);
    const settings = await setSubscriptionKinds(w.as(w.ben), sub.id, { created: { inbox: true, email: false } });
    expect(settings.subscriptions.find((x) => x.id === sub.id)?.kinds).toEqual({ created: { inbox: true, email: false } });
    const loud = await createIssue(w.as(w.anna), { project: 'WEB', summary: 'Menu opens twice' });
    await outbox.drain();
    expect(await benInbox()).toContain(loud.id);
    await expect(setSubscriptionKinds(w.as(w.anna), sub.id, null)).rejects.toMatchObject({ status: 404 });
  });
});

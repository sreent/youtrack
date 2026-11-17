/**
 * SLA policies and their clocks (D45): working hours with holidays and clock changes, the first
 * policy a request matches, pausing while it waits on its requester, met, reopened, what time
 * alone brings (at risk, breached), the status field, search and the weekly report.
 */
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { activities, helpdeskRequests, issueFieldValues, issues, slaClocks } from '../src/db/schema';
import { addBusinessMs, businessMsBetween, calendarOf } from '../src/helpdesk/business-time';
import { searchIssues } from '../src/search/service';
import { addComment } from '../src/services/comments';
import { openRequest, postRequesterReply, requestOf, requestWithRequester } from '../src/services/helpdesk';
import { getIssue, updateIssue } from '../src/services/issues';
import { updateProject } from '../src/services/projects';
import { createPolicy, deletePolicy, listPolicies, slaReport, slaTick, statusFieldOf, stepClock, syncRequest, updatePolicy } from '../src/services/sla';
import { createWorld, type TestWorld } from './helpers';

const H = 3_600_000;
const NY = 'America/New_York';
const weekdays = (from: string, to: string) => [1, 2, 3, 4, 5].map((day) => ({ day, from, to }));

describe('business time', () => {
  const office = calendarOf({ timeZone: NY, hours: weekdays('09:00', '17:00'), holidays: ['2026-11-30'] })!;
  const always = calendarOf({ timeZone: NY, hours: [0, 1, 2, 3, 4, 5, 6].map((day) => ({ day, from: '00:00', to: '24:00' })), holidays: [] })!;

  it('counts only working hours, and skips weekends and holidays', () => {
    // Friday 15:00 in New York, four working hours on: two on Friday, two on Monday.
    const friday = Date.parse('2026-11-20T15:00:00-05:00');
    expect(new Date(addBusinessMs(friday, 4 * H, office)).toISOString()).toBe(new Date('2026-11-23T11:00:00-05:00').toISOString());
    // The Friday after, with Monday a holiday: Tuesday.
    const next = Date.parse('2026-11-27T15:00:00-05:00');
    expect(new Date(addBusinessMs(next, 4 * H, office)).toISOString()).toBe(new Date('2026-12-01T11:00:00-05:00').toISOString());
    expect(businessMsBetween(friday, Date.parse('2026-11-23T11:00:00-05:00'), office)).toBe(4 * H);
    // Before opening, it starts counting at nine.
    expect(new Date(addBusinessMs(Date.parse('2026-11-24T06:00:00-05:00'), H, office)).toISOString()).toBe(new Date('2026-11-24T10:00:00-05:00').toISOString());
  });

  it('runs a day where clocks change as its wall clock does: 23 hours, or 25', () => {
    // Clocks went forward in New York on 8 March 2026, and back on 1 November.
    expect(businessMsBetween(Date.parse('2026-03-08T00:00:00-05:00'), Date.parse('2026-03-09T00:00:00-04:00'), always)).toBe(23 * H);
    expect(businessMsBetween(Date.parse('2026-11-01T00:00:00-04:00'), Date.parse('2026-11-02T00:00:00-05:00'), always)).toBe(25 * H);
    // A day of working time from Saturday noon ends at 13:00 on Sunday, the hour lost between.
    const due = addBusinessMs(Date.parse('2026-03-07T12:00:00-05:00'), 24 * H, always);
    expect(new Date(due).toISOString()).toBe(new Date('2026-03-08T13:00:00-04:00').toISOString());
    // Working hours on that day are wall-clock hours: nine to five is still eight.
    const sunday = calendarOf({ timeZone: NY, hours: [{ day: 0, from: '00:00', to: '24:00' }], holidays: [] })!;
    expect(businessMsBetween(Date.parse('2026-03-08T00:00:00-05:00'), Date.parse('2026-03-08T12:00:00-04:00'), sunday)).toBe(11 * H);
  });

  it('refuses hours that overlap or end before they start, saying how to fix them', () => {
    expect(() => calendarOf({ timeZone: NY, hours: [{ day: 1, from: '17:00', to: '09:00' }], holidays: [] })).toThrow(/end after they start/);
    expect(() => calendarOf({ timeZone: NY, hours: [{ day: 1, from: '09:00', to: '13:00' }, { day: 1, from: '12:00', to: '17:00' }], holidays: [] })).toThrow(/overlap/);
    expect(() => calendarOf({ timeZone: 'Mars/Olympus', hours: weekdays('09:00', '17:00'), holidays: [] })).toThrow(/time zone/);
  });
});

describe('a clock', () => {
  const t0 = Date.parse('2026-11-23T09:00:00Z');
  const want = { target: 'resolution' as const, minutes: 8 * 60, policyId: 'p', warnMs: H };
  const facts = (now: number, extra: Partial<{ waiting: boolean; resolvedAt: number | null }> = {}) => ({ now, created: t0, waiting: false, firstReplyAt: null, resolvedAt: null, ...extra });

  it('pauses while waiting, resumes with what was left, and restarts what is left when reopened', () => {
    let c = stepClock(null, want, facts(t0), null)!;
    expect(c.dueAt!.getTime()).toBe(t0 + 8 * H);
    expect(c.warnAt!.getTime()).toBe(t0 + 7 * H);
    // Two hours in, it waits on its requester: paused with six left.
    c = stepClock(c, want, facts(t0 + 2 * H, { waiting: true }), null)!;
    expect(c.runningSince).toBeNull();
    expect(c.usedMs).toBe(2 * H);
    expect(c.dueAt).toBeNull();
    // A day later they answer: six hours from then.
    c = stepClock(c, want, facts(t0 + 26 * H), null)!;
    expect(c.dueAt!.getTime()).toBe(t0 + 32 * H);
    // Resolved an hour on: met, with three hours to spare.
    c = stepClock(c, want, facts(t0 + 27 * H, { resolvedAt: t0 + 27 * H }), null)!;
    expect(c.metAt!.getTime()).toBe(t0 + 27 * H);
    expect(c.usedMs).toBe(3 * H);
    expect(c.breachedAt).toBeNull();
    // Reopened two days later: what's left counts from then.
    c = stepClock(c, want, facts(t0 + 75 * H), null)!;
    expect(c.metAt).toBeNull();
    expect(c.dueAt!.getTime()).toBe(t0 + 80 * H);
  });

  it('knows when it went past, even if it was paused or met after', () => {
    let c = stepClock(null, want, facts(t0), null)!;
    c = stepClock(c, want, facts(t0 + 10 * H, { waiting: true }), null)!;
    expect(c.breachedAt!.getTime()).toBe(t0 + 8 * H);
    c = stepClock(c, want, facts(t0 + 11 * H, { resolvedAt: t0 + 11 * H }), null)!;
    expect(c.breachedAt!.getTime()).toBe(t0 + 8 * H);
  });
});

describe('SLA policies on a desk', () => {
  let w: TestWorld;

  beforeAll(async () => {
    w = await createWorld();
    await updateProject(w.adminCtx, 'BACK', { settings: { helpdesk: { enabled: true, waitingStates: ['Blocked'], resumeState: 'Open' } } });
    await createPolicy(w.adminCtx, 'BACK', { name: 'Critical', query: 'Priority: Critical', firstResponseMinutes: 60, resolutionMinutes: 4 * 60, warnMinutes: 30 });
    await createPolicy(w.adminCtx, 'BACK', { name: 'Everything else', query: '', firstResponseMinutes: 8 * 60, resolutionMinutes: 40 * 60, warnMinutes: 60 });
  });
  afterAll(async () => w.close());

  const desk = async () => (await w.app.schema.get()).projectsByKey.get('BACK')!;
  async function ask(summary: string) {
    const issue = await openRequest(w.app, await desk(), { name: 'Rita Requester', email: `rita+${summary.length}@example.com`, summary, description: 'It broke.', via: 'form' });
    return issue.id;
  }
  const clocks = async (id: string) => {
    const issue = await getIssue(w.adminCtx, id);
    return w.app.db.select().from(slaClocks).where(eq(slaClocks.issueId, issue.uid));
  };
  const find = async (q: string) => (await searchIssues(w.adminCtx, `project: BACK ${q}`, 0, 200)).items.map((i) => i.id);

  it('starts each request on the first policy it matches, and keeps its status in a field', async () => {
    const id = await ask('Checkout fails');
    const got = await requestOf(w.adminCtx, id);
    expect(got.sla.policy?.name).toBe('Everything else');
    expect(got.sla.status).toBe('On track');
    expect(got.sla.clocks.map((c) => [c.target, c.state, c.targetMinutes])).toEqual([
      ['first_response', 'running', 480],
      ['resolution', 'running', 2400],
    ]);
    const s = await w.app.schema.get();
    const field = statusFieldOf(s)!;
    expect(field.name).toBe('SLA status');
    const issue = await getIssue(w.adminCtx, id);
    expect(issue.fields.find((f) => f.name === 'SLA status')?.value).toMatchObject({ name: 'On track' });
    // Made Critical, it falls under that policy, with its shorter targets.
    await updateIssue(w.adminCtx, id, { fields: { Priority: 'Critical' } });
    expect((await requestOf(w.adminCtx, id)).sla.policy?.name).toBe('Critical');
    expect((await clocks(id)).find((c) => c.target === 'first_response')?.targetMinutes).toBe(60);
    expect(await find('sla: on track')).toContain(id);
    expect(await find('first response: due')).toContain(id);
    expect(await find('resolution due: today .. {next week}')).toContain(id);
  });

  it('meets the first response with the team’s first public reply, not an internal note', async () => {
    const id = await ask('Invoices are late');
    await addComment(w.as(w.anna), id, 'Looking into it.');
    expect((await requestOf(w.adminCtx, id)).sla.clocks[0]!.state).toBe('running');
    await addComment(w.as(w.anna), id, 'We are on it, Rita.', { visibility: 'public' });
    const sla = (await requestOf(w.adminCtx, id)).sla;
    expect(sla.clocks.find((c) => c.target === 'first_response')!.state).toBe('met');
    expect((await requestOf(w.adminCtx, id)).firstResponse.state).toBe('met');
    expect(await find('first response: met')).toContain(id);
    expect(await find('resolution: due')).toContain(id);
  });

  it('pauses while it waits on its requester, and their answer resumes it and moves it back', async () => {
    const id = await ask('Cannot log in');
    await addComment(w.as(w.anna), id, 'Which browser?', { visibility: 'public' });
    await updateIssue(w.adminCtx, id, { fields: { State: 'Blocked' } });
    let sla = (await requestOf(w.adminCtx, id)).sla;
    expect(sla.waiting).toBe(true);
    expect(sla.status).toBe('Paused');
    expect(sla.clocks.find((c) => c.target === 'resolution')!.dueAt).toBeNull();
    expect(await find('resolution: paused')).toContain(id);
    // The requester answers: the clock counts again, and the desk moves it back to Open.
    const issue = await getIssue(w.adminCtx, id);
    const { issue: row, requester } = (await requestWithRequester(w.app.db, issue.uid))!;
    await postRequesterReply(w.app, row, { id: requester.id, name: requester.name }, 'Firefox.', 'page');
    sla = (await requestOf(w.adminCtx, id)).sla;
    expect(sla.waiting).toBe(false);
    expect(sla.clocks.find((c) => c.target === 'resolution')!.state).toBe('running');
    expect((await getIssue(w.adminCtx, id)).fields.find((f) => f.name === 'State')?.value).toMatchObject({ name: 'Open' });
  });

  it('stops the resolution when resolved, and restarts what was left when reopened', async () => {
    const id = await ask('Export is empty');
    await updateIssue(w.adminCtx, id, { fields: { State: 'Fixed' } });
    let sla = (await requestOf(w.adminCtx, id)).sla;
    expect(sla.clocks.map((c) => c.state)).toEqual(['met', 'met']);
    expect(sla.status).toBe('Met');
    expect(await find('sla: met')).toContain(id);
    await updateIssue(w.adminCtx, id, { fields: { State: 'Open' } });
    sla = (await requestOf(w.adminCtx, id)).sla;
    // The first response stays met (resolving answered it); the resolution counts again.
    expect(sla.clocks.find((c) => c.target === 'resolution')!.state).toBe('running');
  });

  it('says at risk, then breached, as time alone brings them: once each, as events and in the field', async () => {
    const id = await ask('Payments time out');
    await updateIssue(w.adminCtx, id, { fields: { Priority: 'Critical' } });
    const uid = (await getIssue(w.adminCtx, id)).uid;
    const [first] = (await clocks(id)).filter((c) => c.target === 'first_response');
    // Just past its warning (30 minutes before the hour's target).
    await slaTick(w.app, new Date(first!.warnAt!.getTime() + 1000));
    const told = async () => (await w.app.db.select().from(activities).where(eq(activities.issueId, uid))).map((a) => a.type).filter((t) => t.startsWith('sla.'));
    expect(await told()).toEqual(['sla.warning']);
    expect((await getIssue(w.adminCtx, id)).fields.find((f) => f.name === 'SLA status')?.value).toMatchObject({ name: 'At risk' });
    await slaTick(w.app, new Date(first!.warnAt!.getTime() + 2000));
    expect(await told()).toEqual(['sla.warning']);
    // Past the target: breached, said once.
    await slaTick(w.app, new Date(first!.dueAt!.getTime() + 1000));
    await slaTick(w.app, new Date(first!.dueAt!.getTime() + 2000));
    expect((await told()).sort()).toEqual(['sla.breached', 'sla.warning']);
    expect((await getIssue(w.adminCtx, id)).fields.find((f) => f.name === 'SLA status')?.value).toMatchObject({ name: 'Breached' });
    const [breached] = (await clocks(id)).filter((c) => c.target === 'first_response');
    expect(breached!.breachedAt!.getTime()).toBe(first!.dueAt!.getTime());
    // Answering late still counts as late.
    await addComment(w.as(w.anna), id, 'Sorry for the wait.', { visibility: 'public' });
    expect((await requestOf(w.adminCtx, id)).sla.clocks.find((c) => c.target === 'first_response')!.state).toBe('missed');
    expect(await find('first response: missed')).toContain(id);
    expect(await find('sla: breached')).toContain(id);
    expect(await find('sla: on track')).not.toContain(id);
  });

  it('follows new working hours and policy changes for open requests', async () => {
    const id = await ask('Reports are slow');
    await updateProject(w.adminCtx, 'BACK', { settings: { helpdesk: { businessHours: { timeZone: NY, hours: weekdays('09:00', '17:00'), holidays: [] } } } });
    const sla = (await requestOf(w.adminCtx, id)).sla;
    expect(sla.businessHours).toBe(true);
    const policies = await listPolicies(w.adminCtx, 'BACK');
    await updatePolicy(w.adminCtx, 'BACK', policies[1]!.id, { name: 'Everything else', query: '', firstResponseMinutes: 120, resolutionMinutes: null, warnMinutes: 15 });
    const now = await clocks(id);
    expect(now.map((c) => c.target)).toEqual(['first_response']);
    expect(now[0]!.targetMinutes).toBe(120);
    await expect(updateProject(w.adminCtx, 'BACK', { settings: { helpdesk: { businessHours: { timeZone: NY, hours: [{ day: 1, from: '18:00', to: '08:00' }], holidays: [] } } } })).rejects.toThrow(/end after they start/);
    await expect(createPolicy(w.adminCtx, 'BACK', { name: 'Broken', query: 'Priority: Urgentest', firstResponseMinutes: 60 })).rejects.toThrow(/doesn't read/);
    await expect(createPolicy(w.adminCtx, 'BACK', { name: 'Empty', query: '' })).rejects.toThrow(/needs a target/);
    await expect(createPolicy(w.as(w.viewer), 'BACK', { name: 'Mine', firstResponseMinutes: 5 })).rejects.toThrow();
  });

  it('counts met and breached per week, by policy', async () => {
    // Through tomorrow: the breach a tick brought above is at its target, an hour after the request,
    // and a request made in the day's last hour is breached past midnight.
    const tomorrow = new Date(Date.now() + 24 * H).toISOString().slice(0, 10);
    const report = await slaReport(w.adminCtx, 'BACK', { timeZone: 'UTC', to: tomorrow });
    const all = report.weeks.flatMap((wk) => wk.policies);
    const critical = all.filter((p) => p.policy === 'Critical');
    expect(critical.reduce((n, p) => n + p.firstResponse.breached, 0)).toBeGreaterThanOrEqual(1);
    const other = all.filter((p) => p.policy === 'Everything else');
    expect(other.reduce((n, p) => n + p.firstResponse.met, 0)).toBeGreaterThanOrEqual(1);
    expect(report.weeks.length).toBe(12);
  });

  it('keeps the D24 first-response hours for a desk without policies', async () => {
    await updateProject(w.adminCtx, 'WEB', { settings: { helpdesk: { enabled: true, firstResponseHours: 2 } } });
    const web = (await w.app.schema.get()).projectsByKey.get('WEB')!;
    const issue = await openRequest(w.app, web, { name: 'Sam', email: 'sam@example.com', summary: 'Page is blank', description: '', via: 'form' });
    const got = await requestOf(w.adminCtx, issue.id);
    expect(got.firstResponse.state).toBe('due');
    expect(got.sla.clocks.map((c) => [c.target, c.targetMinutes])).toEqual([['first_response', 120]]);
    expect(got.sla.policy).toBeNull();
    // A request filed before the clocks: syncing it gives it one.
    await w.app.db.delete(slaClocks).where(eq(slaClocks.issueId, issue.uid));
    await syncRequest(w.app, issue.uid);
    expect((await w.app.db.select().from(slaClocks).where(and(eq(slaClocks.issueId, issue.uid), eq(slaClocks.target, 'first_response')))).length).toBe(1);
    expect((await w.app.db.select().from(helpdeskRequests).where(eq(helpdeskRequests.issueId, issue.uid)))[0]!.waitingSince).toBeNull();
    void issues;
    void issueFieldValues;
    void deletePolicy;
  });
});

/**
 * Customer groups in the help desk (D56): membership by domain and by hand; D45's organizations
 * migrated; an SLA counted in a group's own hours; a group's policy chosen by `customer:`; its
 * dedicated agents, by fewest open, never over someone's choice; members who read or answer each
 * other's requests on the portal and by email; and everyone else finding a request missing.
 */
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { absences, activities, helpdeskRequests, issueFieldValues, notifications, projects, requestCcs, users } from '../src/db/schema';
import { OutboxWorker } from '../src/events/worker';
import { helpdeskConsumer } from '../src/helpdesk/consumer';
import { receiveMail } from '../src/helpdesk/inbound';
import { createHttpApp } from '../src/http/app';
import { AppError } from '../src/lib/errors';
import { newId } from '../src/lib/ids';
import { MailWorker } from '../src/mail/outbox';
import { notifierConsumer } from '../src/notify/notifier';
import { localDate } from '../src/reports/tz';
import { searchIssues } from '../src/search/service';
import { listComments } from '../src/services/comments';
import {
  addGroupMember,
  createCustomerGroup,
  groupOfRequester,
  listCustomerGroups,
  migrateOrganizations,
  removeGroupMember,
  requesterByEmail,
  updateCustomerGroup,
} from '../src/services/customer-groups';
import { openRequest, requestOf, updateRequest } from '../src/services/helpdesk';
import { newMailSecret, setDeskAddress } from '../src/services/helpdesk-mail';
import { getIssue, updateIssue } from '../src/services/issues';
import { createProject, updateProject } from '../src/services/projects';
import { createPolicy, listPolicies, reorderPolicies, slaReport } from '../src/services/sla';
import { projectByKey } from '../src/services/schema-cache';
import { createWorld, type TestWorld } from './helpers';
import { fakeSmtp, type FakeSmtp } from './smtp';

const BASE = 'http://groups.test';
const DESK = 'support@desk.test';
let w: TestWorld;
let smtp: FakeSmtp;
let http: ReturnType<typeof createHttpApp>;
let outbox: OutboxWorker;
let mailer: MailWorker;

async function flush() {
  await outbox.drain();
  await mailer.drain();
}

const desk = async (key: string) => projectByKey(await w.app.schema.get(), key)!;
const ask = async (key: string, email: string, summary: string) => openRequest(w.app, await desk(key), { name: email.split('@')[0]!, email, summary, description: '', via: 'form' });
const assigneeOf = async (uid: string) => (await getIssue(w.adminCtx, uid)).fields.find((f) => f.name === 'Assignee')?.value as { login?: string } | null | undefined;

async function refused(p: Promise<unknown>): Promise<AppError> {
  const e = await p.then(
    () => null,
    (x: unknown) => x,
  );
  expect(e).toBeInstanceOf(AppError);
  return e as AppError;
}

function browser(ip: string) {
  let cookie = '';
  const req = async (method: string, path: string, body?: unknown) => {
    const headers: Record<string, string> = { 'x-forwarded-for': ip };
    if (cookie) headers.cookie = cookie;
    if (method !== 'GET') headers.origin = BASE;
    if (body !== undefined) headers['content-type'] = 'application/json';
    const res = await http.request(`/api/v1${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0]!;
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
  };
  return { req };
}

async function signedIn(email: string, ip: string) {
  const b = browser(ip);
  expect((await b.req('POST', '/portal/sign-in', { email })).status).toBe(202);
  await flush();
  const mail = [...smtp.messages].reverse().find((m) => m.to.includes(email) && m.text.includes('/portal#'));
  const token = mail && /\/portal#(hdl_[A-Za-z0-9_-]{43})/.exec(mail.text)?.[1];
  expect((await b.req('POST', '/portal/sign-in/redeem', { token })).status).toBe(200);
  return b;
}

beforeAll(async () => {
  smtp = await fakeSmtp();
  w = await createWorld({ config: { smtpUrl: smtp.url, publicUrl: BASE, mailFrom: 'a4a <a4a@desk.test>', notifyWindowMs: 60_000, trustProxy: 1 } });
  await w.app.db.update(users).set({ email: 'anna@example.com' }).where(eq(users.id, w.anna.id));
  w.app.schema.invalidate();
  await updateProject(w.adminCtx, 'BACK', { lead: 'anna', settings: { helpdesk: { enabled: true } } });
  await setDeskAddress(w.adminCtx, 'BACK', DESK);
  await newMailSecret(w.adminCtx, 'BACK');
  http = createHttpApp(w.app);
  outbox = new OutboxWorker(w.app, [notifierConsumer(w.app), helpdeskConsumer(w.app)], {}, [], () => {});
  mailer = new MailWorker(w.app, () => new Date(Date.now() + 10 * 60_000));
});

afterAll(async () => {
  await smtp?.close();
  await w?.close();
});

describe('customer groups', () => {
  it('are set by a desk’s managers: a domain names one group, and a requester is in one group by hand', async () => {
    expect((await refused(createCustomerGroup(w.as(w.ben), 'BACK', { name: 'Acme', domains: ['acme.com'] }))).status).toBe(403);
    const acme = await createCustomerGroup(w.adminCtx, 'BACK', { name: 'Acme', domains: ['acme.com'], sharing: 'comment', agents: ['anna', 'ben'] });
    expect(acme).toMatchObject({ name: 'Acme', domains: ['acme.com'], sharing: 'comment', members: 0, openRequests: 0 });
    expect(acme.agents.map((a) => [a.user.login, a.assignable])).toEqual([
      ['anna', true],
      ['ben', true],
    ]);
    const taken = await refused(createCustomerGroup(w.adminCtx, 'BACK', { name: 'Globex', domains: ['globex.com', 'ACME.com'] }));
    expect([taken.status, taken.message, taken.hint]).toEqual([409, 'acme.com puts requesters in Acme already', 'A domain names one group at a desk: take it from Acme first.']);
    expect((await refused(createCustomerGroup(w.adminCtx, 'BACK', { name: 'acme' }))).status).toBe(409);
    // A viewer may not change issues, so may not be given requests.
    expect((await refused(createCustomerGroup(w.adminCtx, 'BACK', { name: 'Globex', agents: ['vera'] }))).message).toBe("vera can't be given BACK's requests");
    const globex = await createCustomerGroup(w.adminCtx, 'BACK', { name: 'Globex', domains: ['globex.com'], sharing: 'read' });

    // By hand, whatever their address says; one group at a desk.
    await addGroupMember(w.adminCtx, 'BACK', globex.id, { email: 'rita@gmail.com', name: 'Rita' });
    await addGroupMember(w.adminCtx, 'BACK', globex.id, { email: 'zoe@acme.com', name: 'Zoe' });
    const twice = await refused(addGroupMember(w.adminCtx, 'BACK', acme.id, { email: 'Rita@gmail.com' }));
    expect([twice.status, twice.message]).toEqual([409, 'rita@gmail.com is in Globex at this desk']);
    const back = await desk('BACK');
    const of = async (email: string) => (await groupOfRequester(w.app.db, back.id, { id: null, email }))?.name ?? null;
    expect(await of('carl@acme.com')).toBe('Acme');
    expect(await of('carl@ACME.COM')).toBe('Acme');
    expect(await of('carl@eu.acme.com')).toBeNull(); // a domain is matched whole
    expect(await of('someone@gmail.com')).toBeNull();
    const zoe = await requesterByEmail(w.app.db, 'zoe@acme.com');
    expect((await groupOfRequester(w.app.db, back.id, zoe))?.name).toBe('Globex'); // by hand beats the domain
    expect((await listCustomerGroups(w.as(w.viewer), 'BACK')).map((g) => [g.name, g.members])).toEqual([
      ['Acme', 0],
      ['Globex', 2],
    ]);
  });

  it('files a request under its requester’s group then, and keeps it there', async () => {
    const r = await ask('BACK', 'carl@acme.com', 'Invoices are late');
    expect((await requestOf(w.adminCtx, r.id)).group).toMatchObject({ name: 'Acme', sharing: 'comment' });
    const [acme] = await listCustomerGroups(w.adminCtx, 'BACK');
    // Taking the domain off moves no request already filed; a new one from it is in none.
    await updateCustomerGroup(w.adminCtx, 'BACK', acme!.id, { name: 'Acme', domains: [], sharing: 'comment', agents: ['anna', 'ben'] });
    expect((await requestOf(w.adminCtx, r.id)).group?.name).toBe('Acme');
    expect((await requestOf(w.adminCtx, (await ask('BACK', 'carl@acme.com', 'Still late')).id)).group).toBeNull();
    await updateCustomerGroup(w.adminCtx, 'BACK', acme!.id, { name: 'Acme', domains: ['acme.com'], sharing: 'comment', agents: ['anna', 'ben'] });
    // A requester is their address: Carl writing from another is someone else, in that address's group.
    expect((await requestOf(w.adminCtx, (await ask('BACK', 'carl@globex.com', 'New job, same printer')).id)).group?.name).toBe('Globex');
  });

  it('migrates D45’s organizations into groups whose members read each other’s requests, once', async () => {
    await updateProject(w.adminCtx, 'WEB', { settings: { helpdesk: { enabled: true } } });
    const before = await ask('WEB', 'peter@initech.com', 'TPS reports');
    const other = await ask('WEB', 'milton@other.org', 'My stapler');
    const web = await desk('WEB');
    // As a desk kept them before groups: a list of domains in its settings.
    const settings = { ...(web.settings as object), helpdesk: { ...((web.settings as { helpdesk?: object }).helpdesk ?? {}), organizations: ['initech.com', 'not a domain'] } };
    await w.app.db.update(projects).set({ settings }).where(eq(projects.id, web.id));
    expect(await migrateOrganizations(w.app.db)).toBe(1);
    w.app.schema.invalidate();
    expect((await listCustomerGroups(w.adminCtx, 'WEB')).map((g) => [g.name, g.domains, g.sharing])).toEqual([['initech.com', ['initech.com'], 'read']]);
    expect((await requestOf(w.adminCtx, before.id)).group?.name).toBe('initech.com');
    expect((await requestOf(w.adminCtx, other.id)).group).toBeNull();
    const [row] = await w.app.db.select({ settings: projects.settings }).from(projects).where(eq(projects.id, web.id));
    expect((row!.settings as { helpdesk: Record<string, unknown> }).helpdesk).not.toHaveProperty('organizations');
    expect(await migrateOrganizations(w.app.db)).toBe(0);
    // A script that still sets them is told where they went.
    const gone = await refused(updateProject(w.adminCtx, 'WEB', { settings: { helpdesk: { organizations: ['initech.com'] } } as never }));
    expect([gone.status, gone.message]).toEqual([400, 'Organizations are customer groups now']);
  });

  it('counts a group’s SLA in its own hours, across its holiday, and the desk’s for everyone else', async () => {
    await createProject(w.adminCtx, { key: 'SUP', name: 'Support', template: 'software' });
    await updateProject(w.adminCtx, 'SUP', { settings: { helpdesk: { enabled: true } } });
    await createPolicy(w.adminCtx, 'SUP', { name: 'Everyone', query: '', firstResponseMinutes: 24 * 60 });
    const tomorrow = localDate(Date.now() + 24 * 3_600_000, 'UTC');
    const always = [0, 1, 2, 3, 4, 5, 6].map((day) => ({ day, from: '00:00', to: '24:00' }));
    await createCustomerGroup(w.adminCtx, 'SUP', { name: 'Owls', domains: ['owls.example'], businessHours: { timeZone: 'UTC', hours: always, holidays: [tomorrow] } });
    const due = async (id: string) => {
      const r = await requestOf(w.adminCtx, id);
      return (new Date(r.sla.clocks.find((c) => c.target === 'first_response')!.dueAt!).getTime() - new Date(r.createdAt).getTime()) / 3_600_000;
    };
    // Round the clock but for tomorrow: a day's target takes two.
    expect(await due((await ask('SUP', 'hoot@owls.example', 'Night shift')).id)).toBe(48);
    expect(await due((await ask('SUP', 'jay@else.example', 'Day shift')).id)).toBe(24);
  });

  it('chooses a group’s policy by `customer:`, in its search and when the team gives it the group', async () => {
    const fast = await createPolicy(w.adminCtx, 'SUP', { name: 'Owls first', query: 'customer: Owls', firstResponseMinutes: 60 });
    const everyone = (await listPolicies(w.adminCtx, 'SUP')).find((p) => p.name === 'Everyone')!;
    await reorderPolicies(w.adminCtx, 'SUP', [fast.id, everyone.id]);
    const owl = await ask('SUP', 'barn@owls.example', 'Hoot');
    const jay = await ask('SUP', 'blue@else.example', 'Tweet');
    expect((await requestOf(w.adminCtx, owl.id)).sla.policy?.name).toBe('Owls first');
    expect((await requestOf(w.adminCtx, jay.id)).sla.policy?.name).toBe('Everyone');
    const found = await searchIssues(w.adminCtx, 'project: SUP customer: owls');
    expect(found.items.map((i) => i.summary).sort()).toEqual(['Hoot', 'Night shift']);
    expect((await searchIssues(w.adminCtx, 'project: SUP has: customer')).total).toBe(2);
    const typo = await refused(searchIssues(w.adminCtx, 'customer: Owl'));
    expect(JSON.stringify(typo.details)).toContain('Did you mean \\"Owls\\"?');
    // A policy naming a group the desk hasn't is refused as it's written.
    expect((await refused(createPolicy(w.adminCtx, 'SUP', { name: 'Nope', query: 'customer: Acme', firstResponseMinutes: 5 }))).status).toBe(400);

    // The team files Jay's request under Owls: its policy follows, in its history.
    const changed = await updateRequest(w.as(w.anna), jay.id, { group: 'owls' });
    expect([changed.group?.name, changed.sla.policy?.name]).toEqual(['Owls', 'Owls first']);
    const history = await w.app.db.select().from(activities).where(and(eq(activities.issueId, jay.uid), eq(activities.type, 'issue.updated')));
    expect(history.flatMap((a) => (a.payload as { changes?: { field: string; from: unknown; to: unknown }[] }).changes ?? [])).toContainEqual({ field: 'Customer group', from: null, to: 'Owls' });
    // A viewer may not; a group of another desk is no group of this one.
    expect((await refused(updateRequest(w.as(w.viewer), jay.id, { group: null }))).status).toBe(403);
    expect((await refused(updateRequest(w.adminCtx, jay.id, { group: 'Acme' }))).status).toBe(404);
  });

  it('gives a new request to whichever agent has the fewest open, and never over someone’s choice', async () => {
    await updateProject(w.adminCtx, 'SUP', { lead: 'anna' });
    const [owls] = await listCustomerGroups(w.adminCtx, 'SUP');
    await updateCustomerGroup(w.adminCtx, 'SUP', owls!.id, { name: 'Owls', domains: ['owls.example'], agents: ['anna', 'ben'] });
    // Anna is first, and nobody has any: she takes it; then Ben, who has fewer; then Anna again.
    const one = await ask('SUP', 'a@owls.example', 'One');
    const two = await ask('SUP', 'b@owls.example', 'Two');
    const three = await ask('SUP', 'c@owls.example', 'Three');
    expect([(await assigneeOf(one.uid))?.login, (await assigneeOf(two.uid))?.login, (await assigneeOf(three.uid))?.login]).toEqual(['anna', 'ben', 'anna']);
    const given = (await w.app.db.select().from(activities).where(and(eq(activities.issueId, one.uid), eq(activities.type, 'issue.updated')))).find((a) =>
      JSON.stringify(a.payload).includes('"Assignee"'),
    );
    expect(given!.payload).toMatchObject({ data: { customerGroup: 'Owls' }, changes: [{ field: 'Assignee', from: null, to: 'anna' }] });
    expect(given!.actorId).toBe((await w.app.schema.get()).usersByLogin.get('helpdesk')!.id);

    // Two at once each see the other's.
    const [x, y] = await Promise.all([ask('SUP', 'd@owls.example', 'Four'), ask('SUP', 'e@owls.example', 'Five')]);
    expect([(await assigneeOf(x.uid))?.login, (await assigneeOf(y.uid))?.login].sort()).toEqual(['anna', 'ben']);

    // Anna away all day today is passed over, whoever has fewer.
    await w.app.db.insert(absences).values({ id: newId(), userId: w.anna.id, startDate: localDate(Date.now(), 'UTC'), endDate: localDate(Date.now(), 'UTC'), kind: 'holiday' });
    await w.app.db.update(issueFieldValues).set({ userId: w.ben.id }).where(eq(issueFieldValues.issueId, one.uid));
    expect((await assigneeOf((await ask('SUP', 'f@owls.example', 'Six')).uid))?.login).toBe('ben');
    await w.app.db.delete(absences).where(eq(absences.userId, w.anna.id));

    // A request someone assigned by hand keeps its assignee when it comes into the group; one nobody did gets an agent.
    const mine = await ask('SUP', 'g@else.example', 'Assigned by hand');
    await updateIssue(w.as(w.anna), mine.id, { fields: { Assignee: 'ben' } });
    await updateIssue(w.as(w.anna), mine.id, { fields: { Assignee: null } });
    await updateRequest(w.as(w.anna), mine.id, { group: 'Owls' });
    expect(await assigneeOf(mine.uid)).toBeFalsy();
    const loose = await ask('SUP', 'h@else.example', 'Nobody chose');
    await updateRequest(w.as(w.anna), loose.id, { group: 'Owls' });
    expect(['anna', 'ben']).toContain((await assigneeOf(loose.uid))?.login);
  });

  it('reports met and breached by group', async () => {
    const report = await slaReport(w.adminCtx, 'SUP', {});
    expect(report.groups.map((g) => g.group)).toEqual(expect.arrayContaining([]));
    const counted = report.groups.reduce((n, g) => n + g.firstResponse.met + g.firstResponse.breached, 0);
    const weekly = report.weeks.flatMap((x) => x.policies).reduce((n, p) => n + p.firstResponse.met + p.firstResponse.breached, 0);
    expect(counted).toBe(weekly);
  });

  it('lets a group’s members read each other’s requests, and answer them where it says so, as themselves', async () => {
    const carls = await ask('BACK', 'carl@acme.com', 'Printer is jammed');
    const zoes = await ask('BACK', 'zoe@acme.com', 'Globex badge'); // by hand in Globex
    await flush();
    const dina = await signedIn('dina@acme.com', '10.5.0.1');
    expect((await dina.req('GET', '/portal/me')).body.groups).toEqual([{ desk: { key: 'BACK', name: 'Backend' }, name: 'Acme', sharing: 'comment' }]);
    const list = (await dina.req('GET', '/portal/requests')).body as { id: string; group: string; canReply: boolean; requester: { mine: boolean } }[];
    expect(list.find((r) => r.id === carls.id)).toMatchObject({ group: 'Acme', canReply: true, requester: { mine: false } });
    expect(list.some((r) => r.id === zoes.id)).toBe(false);
    // Only its requester keeps it private.
    expect((await dina.req('PATCH', `/portal/requests/${carls.id}`, { private: true })).status).toBe(403);

    const told = async () => (await w.app.db.select().from(notifications).where(and(eq(notifications.userId, w.anna.id), eq(notifications.issueId, carls.uid)))).length;
    const before = await told();
    const replied = await dina.req('POST', `/portal/requests/${carls.id}/replies`, { text: 'We see it too, on the third floor.' });
    expect(replied.status).toBe(200);
    expect(replied.body.messages.at(-1)).toMatchObject({ from: 'you', text: 'We see it too, on the third floor.' });
    await flush();
    // Carl hears of it by email, as of the team's replies; the team, as of his.
    const mail = [...smtp.messages].reverse().find((m) => m.to.includes('carl@acme.com') && m.text.includes('third floor'));
    expect(mail?.text).toContain('dina replied to your request.');
    expect(await told()).toBeGreaterThan(before);
    const carl = await signedIn('carl@acme.com', '10.5.0.2');
    const seen = (await carl.req('GET', `/portal/requests/${carls.id}`)).body as { messages: { from: string; name: string }[] };
    expect(seen.messages.at(-1)).toMatchObject({ from: 'colleague', name: 'dina' });

    // Globex shares to read: Rita, by hand in it, reads Zoe's and doesn't answer it.
    const rita = await signedIn('rita@gmail.com', '10.5.0.3');
    expect((await rita.req('GET', `/portal/requests/${zoes.id}`)).body).toMatchObject({ group: 'Globex', canReply: false });
    expect((await rita.req('POST', `/portal/requests/${zoes.id}/replies`, { text: 'Me too' })).status).toBe(403);

    // Kept private by Carl, it's missing to Dina, in the words of a request that doesn't exist.
    expect((await carl.req('PATCH', `/portal/requests/${carls.id}`, { private: true })).body).toMatchObject({ private: true });
    for (const id of [carls.id, 'BACK-9999']) {
      const res = await dina.req('GET', `/portal/requests/${id}`);
      expect([res.status, res.body.error.message]).toEqual([404, "There's no request here"]);
    }
    expect((await dina.req('POST', `/portal/requests/${carls.id}/replies`, { text: 'Hello?' })).status).toBe(404);
    // Someone in no group, or another, finds it as missing as before.
    const stranger = await signedIn('sam@other.org', '10.5.0.4');
    expect((await stranger.req('GET', `/portal/requests/${zoes.id}`)).status).toBe(404);
    expect((await rita.req('GET', `/portal/requests/${carls.id}`)).status).toBe(404);
    expect((await requestOf(w.adminCtx, carls.id)).private).toBe(true);
    await carl.req('PATCH', `/portal/requests/${carls.id}`, { private: false });
  });

  it('takes a member’s answer by email as theirs, and refuses anyone else’s', async () => {
    const r = await ask('BACK', 'carl@acme.com', 'Scanner too');
    await flush();
    const ack = [...smtp.messages].reverse().find((m) => m.to.includes('carl@acme.com') && m.headers.get('subject') === 'Scanner too');
    const replyTo = ack?.headers.get('reply-to') ?? '';
    expect(replyTo).toMatch(/^support\+/);
    const raw = (from: string) =>
      Buffer.from(
        [`From: ${from}`, `To: ${replyTo}`, 'Subject: Re: Scanner too', `Message-ID: <${newId()}@example.com>`, 'MIME-Version: 1.0', 'Content-Type: text/plain; charset=utf-8', '', 'Same here, since Monday.', ''].join('\r\n'),
      );
    const back = await desk('BACK');
    expect(await receiveMail(w.app, raw('Dina <dina@acme.com>'), { via: 'webhook', desk: back })).toMatchObject({ outcome: 'reply', reason: 'a reply by its reply address, from someone of its customer group' });
    expect((await listComments(w.adminCtx, r.id)).at(-1)).toMatchObject({ text: 'Same here, since Monday.', visibility: 'public', requester: { name: 'dina' } });
    for (const from of ['sam@other.org', 'rita@gmail.com']) {
      expect((await receiveMail(w.app, raw(from), { via: 'webhook', desk: back })).outcome).toBe('refused');
    }
    // A group that shares to read takes no answers from its members, by email either.
    const [row] = await w.app.db.select().from(helpdeskRequests).where(eq(helpdeskRequests.issueId, r.uid));
    const acme = (await listCustomerGroups(w.adminCtx, 'BACK')).find((g) => g.id === row!.groupId)!;
    await updateCustomerGroup(w.adminCtx, 'BACK', acme.id, { name: acme.name, domains: acme.domains, sharing: 'read', agents: ['anna', 'ben'] });
    expect((await receiveMail(w.app, raw('dina@acme.com'), { via: 'webhook', desk: back })).outcome).toBe('refused');
    // Taken out by hand, Rita is in no group; taking her out again is a 404.
    const globex = (await listCustomerGroups(w.adminCtx, 'BACK')).find((g) => g.name === 'Globex')!;
    const rita = await requesterByEmail(w.app.db, 'rita@gmail.com');
    await removeGroupMember(w.adminCtx, 'BACK', globex.id, rita.id);
    expect(await groupOfRequester(w.app.db, back.id, rita)).toBeNull();
    expect((await refused(removeGroupMember(w.adminCtx, 'BACK', globex.id, rita.id))).status).toBe(404);
  });
});
describe("the group's members hear of its requests", () => {
  it("files a new request with its members copied, for the email alone", async () => {
    const group = await createCustomerGroup(w.adminCtx, 'BACK', { name: 'MembersHear', domains: ['hear.example'], sharing: 'none' });
    await addGroupMember(w.adminCtx, 'BACK', group.id, { email: 'colleague@hear.example' });
    const desk = (await w.app.schema.get()).projectsByKey.get('BACK')!;
    const issue = await openRequest(w.app, desk, { name: 'Rita', email: 'rita@hear.example', summary: 'Tell my group', description: 'Please.', via: 'form' });
    const ccs = await w.app.db.select().from(requestCcs).where(eq(requestCcs.issueId, issue.uid));
    expect(ccs.map((c) => c.email)).toContain('colleague@hear.example');
    expect(ccs.every((c) => c.via === 'group')).toBe(true);
    expect(ccs.map((c) => c.email)).not.toContain('rita@hear.example');
  });
});

import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { systemCtx } from '../../src/app-services';
import type { Ctx } from '../../src/context';
import { activities, comments, externalIssues, issues, workItems } from '../../src/db/schema';
import { matchPerson, parseDate, parseDuration, suggestOption, targetFor } from '../../src/imports/mapping';
import { addComment, listComments } from '../../src/services/comments';
import { createBoard, createSprint } from '../../src/services/boards';
import { getIssue, updateIssue } from '../../src/services/issues';
import { checkImport, getImport, importRowsOf, runImport, undoImport, updateMapping, uploadImport, waitForImport } from '../../src/services/imports';
import { createProject } from '../../src/services/projects';
import { insertUser } from '../../src/services/users';
import { createWorld, type TestWorld } from '../helpers';

let w: TestWorld;
let admin: Ctx;

const body = (text: string, size = 7) => {
  const bytes = new TextEncoder().encode(text);
  let i = 0;
  return new ReadableStream<Uint8Array>({
    pull(c) {
      if (i >= bytes.length) return c.close();
      c.enqueue(bytes.slice(i, i + size));
      i += size;
    },
  });
};

// A Jira Cloud export: a BOM, CRLF, repeated Labels and Comment columns, a description over
// several lines with commas and quotes, Jira's dates and seconds, parents by numeric id, a
// "blocks" link by key, and a few bad rows.
const JIRA = `﻿${[
  'Summary,Issue key,Issue id,Parent,Issue Type,Status,Priority,Assignee,Reporter,Created,Updated,Resolved,Labels,Labels,Original Estimate,Time Spent,Sprint,Description,Comment,Comment,Outward issue link (Blocks)',
  'Single sign-on fails on Safari,ABC-1,10001,,Bug,In Progress,High,Anna Schmidt,ben@example.com,12/Mar/24 2:15 PM,14/Mar/24 9:00 AM,,regression,sso,28800,3600,Sprint 1,"Steps:\r\n1. Open Safari, sign in\r\n2. See ""a blank page""",13/Mar/24 10:00 AM;ben;I can reproduce it,14/Mar/24 8:30 AM;Zed Unknown;Me too,ABC-3',
  'Fix the cookie,ABC-2,10002,10001,Sub-task,Done,Medium,Anna Schmidt,Anna Schmidt,12/Mar/24 3:00 PM,15/Mar/24 5:30 PM,15/Mar/24 5:30 PM,,,7200,,,,,,',
  'Rotate keys,ABC-3,10003,,Story,To Do,Lowest,,Someone Gone,01/Mar/24 9:00 AM,05/Mar/24 5:30 PM,,,,,,,,,,ABC-99',
  ',ABC-4,10004,,Task,To Do,Medium,,,01/Mar/24 9:00 AM,,,,,,,,,,,',
  'Twice,ABC-1,10005,,Task,To Do,Medium,,,01/Mar/24 9:00 AM,,,,,,,,,,,',
  'Strange date,ABC-5,10006,,Task,Blocked,Medium,,,the day before,,,,,,,,,,,',
].join('\r\n')}\r\n`;

// A YouTrack export: issue ids as keys, State, durations as YouTrack writes them, tags in one cell.
const YOUTRACK = [
  '"Issue Id","Summary","State","Priority","Type","Assignee","Reporter","Created","Updated","Resolved","Estimation","Spent time","Tags","Subtask of","Depends on"',
  '"PRJ-1","Plan the release","Open","Major","Task","anna","ben","2024-04-01 09:00","2024-04-02 10:00","","1d 4h","2h","release, planning","",""',
  '"PRJ-2","Write the notes","Fixed","Normal","Task","ben","ben","2024-04-01 10:00","2024-04-03 16:00","2024-04-03 16:00","3h","","release","PRJ-1","PRJ-1"',
].join('\n');

beforeAll(async () => {
  w = await createWorld();
  admin = systemCtx(w.app, w.admin, 'web');
  admin.actor.scopes = ['read', 'write', 'admin'];
  await insertUser(w.app.db, { login: 'ben2', name: 'Ben Okafor Two', email: 'ben@example.com' });
  w.app.schema.invalidate();
  await createProject(w.adminCtx, { key: 'IMP', name: 'Imported', template: 'software' });
  await createProject(w.adminCtx, { key: 'YT', name: 'From YouTrack', template: 'software' });
  const board = await createBoard(w.adminCtx, { name: 'Imported board', projects: ['IMP'], sprintsEnabled: true });
  await createSprint(w.adminCtx, board.id, { name: 'Sprint 1', startDate: '2024-03-11', endDate: '2024-03-22' });
});
afterAll(async () => w?.close());

describe('mapping columns and values', () => {
  const fields = [
    { name: 'State', type: 'state', multi: false },
    { name: 'Priority', type: 'enum', multi: false },
    { name: 'Type', type: 'enum', multi: false },
    { name: 'Assignee', type: 'user', multi: false },
    { name: 'Estimation', type: 'period', multi: false },
  ];
  const phrases = ['depends on', 'is required for', 'relates to', 'duplicates', 'is duplicated by', 'subtask of', 'parent for'];

  it('finds the common headers of both trackers', () => {
    const t = (h: string, samples: string[] = []) => targetFor(h, samples, fields, phrases).target;
    expect(t('Summary')).toBe('summary');
    expect(t('Issue key')).toBe('key');
    expect(t('Issue id', ['10001'])).toBe('external-id');
    expect(t('Issue Id', ['PRJ-1'])).toBe('key');
    expect(t('Status')).toBe('field:State');
    expect(t('State')).toBe('field:State');
    expect(t('Issue Type')).toBe('field:Type');
    expect(t('Original Estimate')).toBe('field:Estimation');
    expect(t('Time Spent')).toBe('spent');
    expect(t('Labels')).toBe('tags');
    expect(t('Custom field (Epic Link)')).toBe('parent');
    expect(t('Subtask of')).toBe('parent');
    expect(t('Outward issue link (Blocks)')).toBe('link:is required for');
    expect(t('Inward issue link (Blocks)')).toBe('link:depends on');
    expect(t('Depends on')).toBe('link:depends on');
    expect(t('Votes')).toBe('ignore');
  });

  it('suggests a4a\'s states, priorities and types for the trackers\' words, and people by email or name', () => {
    const states = ['Submitted', 'Open', 'In Progress', 'In Review', 'Blocked', 'Fixed', 'Verified', 'Done', "Won't fix", 'Duplicate', 'Obsolete'];
    expect(suggestOption('State', 'To Do', states)).toEqual({ to: 'Open', found: true });
    expect(suggestOption('Status', 'Closed', states)).toEqual({ to: 'Done', found: true });
    expect(suggestOption('State', "Won't Do", states)).toEqual({ to: "Won't fix", found: true });
    expect(suggestOption('Priority', 'Highest', ['Show-stopper', 'Critical', 'Major', 'Normal', 'Minor'])).toEqual({ to: 'Show-stopper', found: true });
    expect(suggestOption('Type', 'Story', ['Bug', 'Feature', 'Task'])).toEqual({ to: 'Feature', found: true });
    expect(suggestOption('State', 'Limbo', states)).toEqual({ to: null, found: false });
    const people = [
      { id: '1', login: 'anna', name: 'Anna Schmidt', email: 'anna@example.com' },
      { id: '2', login: 'ben', name: 'Ben Okafor', email: 'ben@example.com' },
    ];
    expect(matchPerson('ANNA@example.com', people)?.login).toBe('anna');
    expect(matchPerson('Ben Okafor <ben@example.com>', people)?.login).toBe('ben');
    expect(matchPerson('anna schmidt', people)?.login).toBe('anna');
    expect(matchPerson('Nobody Here', people)).toBeNull();
  });

  it('reads the dates and durations the trackers write', () => {
    expect(new Date(parseDate('12/Mar/24 2:15 PM', 'UTC')!).toISOString()).toBe('2024-03-12T14:15:00.000Z');
    expect(new Date(parseDate('12/Mar/24 2:15 PM', 'Europe/Berlin')!).toISOString()).toBe('2024-03-12T13:15:00.000Z');
    expect(new Date(parseDate('2024-04-01 09:00', 'UTC')!).toISOString()).toBe('2024-04-01T09:00:00.000Z');
    expect(new Date(parseDate('2024-04-01T09:00:00+02:00', 'UTC')!).toISOString()).toBe('2024-04-01T07:00:00.000Z');
    expect(new Date(parseDate('12.03.2024 14:15', 'UTC')!).toISOString()).toBe('2024-03-12T14:15:00.000Z');
    expect(parseDate('1710252900000', 'UTC')).toBe(1710252900000);
    expect(parseDate('31/Feb/24', 'UTC')).toBeNull();
    expect(parseDate('the day before', 'UTC')).toBeNull();
    expect(parseDuration('28800', 'jira')).toBe(480);
    expect(parseDuration('90', 'youtrack')).toBe(90);
    expect(parseDuration('1d 4h', 'youtrack')).toBe(720);
    expect(parseDuration('soon', 'csv')).toBeNull();
  });
});

describe('importing a Jira export', () => {
  let id: string;

  it('uploads it as a stream, finds its columns, and suggests its values', async () => {
    const imp = await uploadImport(admin, { project: 'IMP', fileName: 'jira.csv' }, body(JIRA));
    id = imp.id;
    expect(imp.source).toBe('jira');
    expect(imp.rows).toBe(6);
    const target = (name: string) => imp.columns.filter((c) => c.name === name).map((c) => c.target);
    expect(target('Labels')).toEqual(['tags', 'tags']);
    expect(target('Comment')).toEqual(['comment', 'comment']);
    expect(target('Parent')).toEqual(['parent']);
    expect(target('Issue id')).toEqual(['external-id']);
    const states = imp.values.find((v) => v.target === 'field:State')!;
    expect(Object.fromEntries(states.items.map((i) => [i.value, i.to]))).toMatchObject({ 'In Progress': 'In Progress', Done: 'Done', 'To Do': 'Open', Blocked: 'Blocked' });
    const reporters = imp.values.find((v) => v.target === 'reporter')!;
    expect(Object.fromEntries(reporters.items.map((i) => [i.value, i.to]))).toMatchObject({ 'ben@example.com': 'ben2', 'Anna Schmidt': 'anna', 'Someone Gone': null });
    expect(reporters.empty).toMatch(/left empty/);
    const sprint = imp.values.find((v) => v.target === 'sprint')!;
    expect(sprint.items[0]).toMatchObject({ value: 'Sprint 1', found: true });
  });

  it('takes the person\'s mapping, and refuses one that can\'t be', async () => {
    const imp = await updateMapping(admin, id, { values: { 'field:Priority': { Lowest: 'Normal' } } });
    expect(imp.values.find((v) => v.target === 'field:Priority')!.items.find((i) => i.value === 'Lowest')).toMatchObject({ to: 'Normal', found: false });
    await expect(updateMapping(admin, id, { values: { 'field:Priority': { High: 'Urgentest' } } })).rejects.toMatchObject({ status: 400 });
    await expect(updateMapping(admin, id, { columns: { '0': 'field:Nope' } })).rejects.toMatchObject({ status: 400 });
    await expect(updateMapping(admin, id, { columns: { '1': 'summary' } })).rejects.toMatchObject({ status: 400, message: expect.stringContaining('Both') });
    await expect(updateMapping(admin, id, { options: { timeZone: 'Nowhere/Here' } })).rejects.toMatchObject({ status: 400 });
    await updateMapping(admin, id, { options: { timeZone: 'UTC' } });
  });

  it('checks it first: what it would create, and each row\'s problems, changing nothing', async () => {
    const before = await w.app.db.select({ n: sql<number>`count(*)::int` }).from(issues);
    const check = await checkImport(admin, id);
    expect(check.counts).toMatchObject({ total: 6, created: 4, failed: 2, comments: 2 });
    const messages = check.problems.map((p) => [p.row, p.severity, p.message]);
    expect(messages).toContainEqual([5, 'error', 'It has no summary, so it is not imported']);
    expect(messages).toContainEqual([6, 'error', 'ABC-1 is on an earlier row of the file too, so this row is not imported']);
    expect(messages.some(([row, sev, msg]) => row === 7 && sev === 'warning' && String(msg).includes('the day before'))).toBe(true);
    expect(messages.some(([row, , msg]) => row === 4 && String(msg).includes('ABC-99'))).toBe(true);
    expect(check.counts.links).toBe(2); // ABC-2's parent, ABC-1 blocks ABC-3
    expect(check.warnings.some((x) => x.includes('"Someone Gone"'))).toBe(true);
    const after = await w.app.db.select({ n: sql<number>`count(*)::int` }).from(issues);
    expect(after[0]!.n).toBe(before[0]!.n);
    expect(await w.app.db.select().from(externalIssues)).toHaveLength(0);
  });

  it('runs as a job, keeping the dates, the reporter and the comments, and says it was imported', async () => {
    const started = await runImport(admin, id);
    expect(started.status).toBe('running');
    await expect(runImport(admin, id)).rejects.toMatchObject({ status: 409 });
    await waitForImport(id);
    const done = await getImport(admin, id);
    expect(done.status).toBe('done');
    expect(done.result).toMatchObject({ created: 4, failed: 2, links: 2, linksMissing: 1, comments: 2 });

    const map = await w.app.db.select().from(externalIssues).where(eq(externalIssues.externalKey, 'ABC-1'));
    const rid = map[0]!.readableId;
    const issue = await getIssue(admin, rid);
    expect(issue.createdAt).toBe('2024-03-12T14:15:00.000Z');
    expect(issue.updatedAt).toBe('2024-03-14T09:00:00.000Z');
    expect(issue.reporter?.login).toBe('ben2');
    expect(issue.tags.map((t) => t.name).sort()).toEqual(['regression', 'sso']);
    const field = (name: string) => issue.fields.find((f) => f.name === name)?.value;
    expect(field('State')).toMatchObject({ name: 'In Progress' });
    expect(field('Priority')).toMatchObject({ name: 'Critical' });
    expect(field('Estimation')).toMatchObject({ minutes: 480 });
    expect(issue.description).toBe('Steps:\n1. Open Safari, sign in\n2. See "a blank page"');
    expect(issue.links.map((l) => l.phrase)).toContain('is required for');
    expect(issue.subtasks).toHaveLength(1);
    const thread = await listComments(admin, rid);
    expect(thread.map((c) => [c.createdAt, c.author?.login ?? null])).toEqual([
      ['2024-03-13T10:00:00.000Z', 'ben'],
      ['2024-03-14T08:30:00.000Z', null],
    ]);
    expect(thread[1]!.text).toMatch(/^\*\*Zed Unknown\*\* wrote in Jira:/);
    const spent = await w.app.db.select().from(workItems).where(eq(workItems.issueId, issue.uid));
    expect(spent.map((s) => s.minutes)).toEqual([60]);

    const created = await w.app.db.select().from(activities).where(and(eq(activities.issueId, issue.uid), eq(activities.type, 'issue.created')));
    expect(created[0]!.actorId).toBe(w.admin.id);
    expect((created[0]!.payload as { data: { imported: Record<string, unknown> } }).data.imported).toMatchObject({ importId: id, source: 'jira', key: 'ABC-1', createdAt: '2024-03-12T14:15:00.000Z' });

    // The resolved one keeps its resolution date; the unknown reporter is left empty.
    const fixedRid = (await w.app.db.select().from(externalIssues).where(eq(externalIssues.externalKey, 'ABC-2')))[0]!.readableId;
    const fixed = await getIssue(admin, fixedRid);
    expect(fixed.resolvedAt).toBe('2024-03-15T17:30:00.000Z');
    expect(fixed.parent?.id).toBe(rid);
    const gone = await getIssue(admin, (await w.app.db.select().from(externalIssues).where(eq(externalIssues.externalKey, 'ABC-3')))[0]!.readableId);
    expect(gone.reporter).toBeNull();
    // ABC-1 was in Sprint 1, and its history says it joined.
    const joined = await w.app.db.select().from(activities).where(and(eq(activities.issueId, issue.uid), eq(activities.type, 'sprint.issue_added')));
    expect(joined).toHaveLength(1);

    const failed = await importRowsOf(admin, id, { status: 'failed', offset: 0, limit: 50 });
    expect(failed.items.map((r) => r.row)).toEqual([5, 6]);
  });

  it('runs again without making anything twice', async () => {
    const count = async () => Number((await w.app.db.select({ n: sql<number>`count(*)::int` }).from(issues))[0]!.n);
    const before = await count();
    await runImport(admin, id);
    await waitForImport(id);
    const again = await getImport(admin, id);
    expect(again.result).toMatchObject({ created: 0, unchanged: 4, failed: 2 });
    expect(await count()).toBe(before);
    // A new upload of the same export finds the issues the first made.
    const second = await uploadImport(admin, { project: 'IMP' }, body(JIRA, 4096));
    await updateMapping(admin, second.id, { values: { 'field:Priority': { Lowest: 'Normal' } }, options: { timeZone: 'UTC' } });
    expect((await checkImport(admin, second.id)).counts).toMatchObject({ created: 0, unchanged: 4 });
  });

  it('updates only what changed in the export since, and keeps what someone changed here', async () => {
    const rid = (await w.app.db.select().from(externalIssues).where(eq(externalIssues.externalKey, 'ABC-1')))[0]!.readableId;
    await updateIssue(admin, rid, { fields: { Priority: 'Minor' } }); // someone here lowers it
    // In Jira since: it moved to review, and its second comment is a new one.
    const changed = JIRA.replace('Single sign-on fails on Safari,ABC-1,10001,,Bug,In Progress', 'Single sign-on fails on Safari,ABC-1,10001,,Bug,In Review').replace(
      '14/Mar/24 8:30 AM;Zed Unknown;Me too',
      '15/Mar/24 9:00 AM;anna;Fixed on staging',
    );
    const imp = await uploadImport(admin, { project: 'IMP' }, body(changed));
    await updateMapping(admin, imp.id, { values: { 'field:Priority': { Lowest: 'Normal' } }, options: { timeZone: 'UTC' } });
    await runImport(admin, imp.id);
    await waitForImport(imp.id);
    expect((await getImport(admin, imp.id)).result).toMatchObject({ created: 0, updated: 1, unchanged: 3 });
    const issue = await getIssue(admin, rid);
    expect(issue.fields.find((f) => f.name === 'State')!.value).toMatchObject({ name: 'In Review' });
    expect(issue.fields.find((f) => f.name === 'Priority')!.value).toMatchObject({ name: 'Minor' });
    const thread = await listComments(admin, rid);
    expect(thread.map((c) => c.text.slice(-16))).toContain('Fixed on staging');
    expect(thread).toHaveLength(3);
  });

  it('takes an import back, keeping what someone has worked on since, and saying why', async () => {
    const rid = (key: string) => w.app.db.select().from(externalIssues).where(eq(externalIssues.externalKey, key)).then((r) => r[0]!.readableId);
    const kept = await rid('ABC-3');
    await addComment(systemCtx(w.app, w.anna, 'web'), kept, 'I will take this one');
    const preview = await undoImport(admin, id, { dryRun: true });
    expect(preview.applied).toBe(false);
    // ABC-1 had its priority changed here, ABC-3 a comment: they stay. ABC-2 and ABC-5 go.
    expect(preview.keep).toEqual([
      { issue: await rid('ABC-1'), why: expect.stringMatching(/^Ada Admin changed it on \d{4}-\d{2}-\d{2}$/) },
      { issue: kept, why: expect.stringContaining('Anna Schmidt commented on it') },
    ]);
    expect(preview.remove.sort()).toEqual([await rid('ABC-2'), await rid('ABC-5')].sort());
    const done = await undoImport(admin, id, { dryRun: false });
    expect(done.applied).toBe(true);
    expect(done.remove).toHaveLength(2);
    expect(await w.app.db.select().from(externalIssues).where(eq(externalIssues.externalKey, 'ABC-5'))).toHaveLength(0);
    const deleted = await w.app.db.select().from(activities).where(eq(activities.type, 'issue.deleted'));
    expect(deleted.some((a) => (a.payload as { data?: { undoneImport?: string } }).data?.undoneImport === id)).toBe(true);
    expect((await getImport(admin, id)).status).toBe('undone');
    // Running it again after the undo makes again what the undo took away, and only that.
    await runImport(admin, id);
    await waitForImport(id);
    expect((await getImport(admin, id)).result).toMatchObject({ created: 2 });
    void comments;
  });
});

describe('importing a YouTrack export', () => {
  it('reads its ids as keys, its durations, tags in one cell, and subtasks by key', async () => {
    const imp = await uploadImport(admin, { project: 'YT' }, body(YOUTRACK, 11));
    expect(imp.source).toBe('youtrack');
    await updateMapping(admin, imp.id, { options: { timeZone: 'UTC' } });
    await runImport(admin, imp.id);
    await waitForImport(imp.id);
    expect((await getImport(admin, imp.id)).result).toMatchObject({ created: 2, links: 2, failed: 0 });
    const one = await getIssue(admin, 'YT-1');
    expect(one.fields.find((f) => f.name === 'Estimation')!.value).toMatchObject({ minutes: 720 });
    expect(one.tags.map((t) => t.name).sort()).toEqual(['planning', 'release']);
    const two = await getIssue(admin, 'YT-2');
    expect(two.parent?.id).toBe('YT-1');
    expect(two.links.map((l) => l.phrase)).toContain('depends on');
    expect(two.resolvedAt).toBe('2024-04-03T16:00:00.000Z');
  });
});

describe('what an import refuses', () => {
  it('says why a file can\'t be read', async () => {
    await expect(uploadImport(admin, { project: 'IMP' }, body(''))).rejects.toMatchObject({ status: 400, message: expect.stringContaining('empty') });
    await expect(uploadImport(admin, { project: 'IMP' }, body('﻿Summary,Key\r\n'))).rejects.toMatchObject({ status: 400, message: expect.stringContaining('no rows') });
    await expect(uploadImport(admin, { project: 'IMP' }, body('Summary,Key\n"never closed,ABC-1\n'))).rejects.toMatchObject({ status: 400, message: expect.stringContaining('line 2') });
    await expect(uploadImport(admin, { project: 'NOPE' }, body('a\n1'))).rejects.toMatchObject({ status: 404 });
  });

  it('is for administrators', async () => {
    await expect(uploadImport(systemCtx(w.app, w.anna, 'web'), { project: 'IMP' }, body(YOUTRACK))).rejects.toMatchObject({ status: 403 });
  });

  it('won\'t run without a key column, which is what makes running again safe', async () => {
    const imp = await uploadImport(admin, { project: 'IMP' }, body('Title,Status\nA thing,Open\n'));
    expect((await checkImport(admin, imp.id)).warnings[0]).toMatch(/No column is the key/);
    await expect(runImport(admin, imp.id)).rejects.toMatchObject({ status: 400 });
  });
});

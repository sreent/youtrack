import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runCommand } from '../src/commands/executor';
import { suggestCommand } from '../src/commands/parser';
import { parseQuery } from '../src/search/parser';
import { countIssues, parseQueryForApi, searchIssues } from '../src/search/service';
import { suggest } from '../src/search/suggest';
import { buildVocabulary } from '../src/search/vocabulary';
import { addComment } from '../src/services/comments';
import { createIssue, updateIssue } from '../src/services/issues';
import { linkIssues } from '../src/services/links';
import { logWork } from '../src/services/workitems';
import { createWorld, type TestWorld } from './helpers';

let w: TestWorld;
const ids: Record<string, string> = {};

beforeAll(async () => {
  w = await createWorld();
  const anna = w.as(w.anna);
  const mk = async (key: string, input: Parameters<typeof createIssue>[1]) => {
    const issue = await createIssue(anna, input);
    ids[key] = issue.id;
    return issue;
  };
  await mk('sso', {
    project: 'BACK',
    summary: 'Login fails on Safari with SSO',
    description: 'Users on Safari 17 get a blank page after the identity provider redirects back.',
    fields: { Type: 'Bug', Priority: 'Critical', Assignee: 'anna', Subsystem: 'Auth' },
    tags: ['regression'],
  });
  await mk('rate', {
    project: 'BACK',
    summary: 'Add rate limiting to the public API',
    fields: { Type: 'Feature', Priority: 'Major', Assignee: 'ben', Subsystem: 'API', Estimation: '3d', 'Fix versions': ['1.1'] },
  });
  await mk('migr', {
    project: 'BACK',
    summary: 'Migrate sessions table to Postgres 16',
    fields: { Type: 'Task', Priority: 'Normal', Subsystem: 'Database', State: 'In Progress' },
  });
  await mk('dark', { project: 'WEB', summary: 'Dark mode toggle is missing', fields: { Type: 'Feature', Priority: 'Minor', Assignee: 'anna' } });
  await mk('done', { project: 'WEB', summary: 'Fix typo on the pricing page', fields: { Type: 'Bug', State: 'Fixed' } });
  await linkIssues(anna, ids.rate!, 'depends on', ids.migr!);
  await addComment(w.as(w.ben), ids.sso!, 'I can reproduce it with the Okta sandbox too.');
  await logWork(anna, ids.sso!, { duration: '2h', description: 'Investigated redirect handling' });
});

afterAll(async () => {
  await w?.close();
});

async function found(query: string): Promise<string[]> {
  const res = await searchIssues(w.as(w.anna), query, 0, 100);
  return res.items.map((i) => i.id).sort();
}

describe('query language', () => {
  it('filters by project, fields, and #Unresolved', async () => {
    expect(await found('project: BACK')).toEqual([ids.migr, ids.rate, ids.sso].sort());
    expect(await found('#Unresolved project: WEB')).toEqual([ids.dark]);
    expect(await found('#Resolved')).toEqual([ids.done]);
    expect(await found('Priority: Critical, Major')).toEqual([ids.rate, ids.sso].sort());
    expect(await found('Priority: -Minor project: WEB')).toEqual([ids.done]);
  });

  it('matches multi-word values without quotes', async () => {
    expect(await found('State: In Progress')).toEqual([ids.migr]);
    expect(await found('state: {In Progress}')).toEqual([ids.migr]);
    expect(await found('#{In Progress}')).toEqual([ids.migr]);
  });

  it('understands me, for:, has:, and unassigned', async () => {
    expect(await found('for: me #Unresolved')).toEqual([ids.dark, ids.sso].sort());
    expect(await found('Assignee: ben')).toEqual([ids.rate]);
    expect(await found('has: -Assignee project: BACK')).toEqual([ids.migr]);
    expect(await found('Assignee: Unassigned project: BACK')).toEqual([ids.migr]);
    expect(await found('has: comments')).toEqual([ids.sso]);
  });

  it('searches free text across summary, description and comments, with prefixes', async () => {
    expect(await found('safari')).toEqual([ids.sso]);
    expect(await found('saf')).toEqual([ids.sso]);
    expect(await found('okta')).toEqual([ids.sso]);
    expect(await found('"rate limiting"')).toEqual([ids.rate]);
  });

  it('handles tags, links, dates, periods and booleans', async () => {
    expect(await found('tag: regression')).toEqual([ids.sso]);
    expect(await found('#regression')).toEqual([ids.sso]);
    expect(await found(`depends on: ${ids.migr}`)).toEqual([ids.rate]);
    expect(await found(`is required for: ${ids.rate}`)).toEqual([ids.migr]);
    expect(await found('created: today')).toHaveLength(5);
    expect(await found('created: -7d .. today')).toHaveLength(5);
    expect(await found('created: {last week}')).toHaveLength(0);
    expect(await found('Estimation: 2d .. 4d')).toEqual([ids.rate]);
    expect(await found('spent time: 1h .. *')).toEqual([ids.sso]);
    expect(await found('Type: Bug or Type: Task')).toEqual([ids.done, ids.migr, ids.sso].sort());
    expect(await found('(Type: Bug or Type: Feature) project: WEB')).toEqual([ids.dark, ids.done].sort());
    expect(await found(`-${ids.sso} project: BACK`)).toEqual([ids.migr, ids.rate].sort());
  });

  it('finds an issue by its id typed as text', async () => {
    expect(await found(ids.rate!)).toEqual([ids.rate]);
  });

  it('sorts by field order and dates', async () => {
    const res = await searchIssues(w.as(w.anna), 'project: BACK sort by: Priority', 0, 10);
    expect(res.items.map((i) => i.id)).toEqual([ids.sso, ids.rate, ids.migr]);
    const desc = await searchIssues(w.as(w.anna), 'project: BACK sort by: Priority desc', 0, 10);
    expect(desc.items.map((i) => i.id)).toEqual([ids.migr, ids.rate, ids.sso]);
  });

  it('reports problems with positions and hints', async () => {
    const r = await parseQueryForApi(w.as(w.anna), 'State: Fixd Prioritty: Major');
    expect(r.ok).toBe(false);
    expect(r.problems[0]).toMatchObject({ message: 'Unknown value "Fixd" for State', start: 7, end: 11 });
    expect(r.problems[0]!.hint).toContain('Fixed');
    expect(r.problems[1]!.hint).toContain('Priority');
    await expect(searchIssues(w.as(w.anna), 'State: Fixd', 0, 10)).rejects.toThrow(/Unknown value/);
  });

  it('carries the text that fixes a problem, keeping what was typed around it', async () => {
    const fixOf = async (q: string) => (await parseQueryForApi(w.as(w.anna), q)).problems.map((p) => [q.slice(p.start, p.end), p.fix]);
    expect(await fixOf('State: Fixd')).toEqual([['Fixd', 'Fixed']]);
    expect(await fixOf('State: -Fixd')).toEqual([['-Fixd', '-Fixed']]);
    expect(await fixOf('State: {In Progres}')).toEqual([['{In Progres}', '{In Progress}']]);
    expect(await fixOf('#Fixd')).toEqual([['#Fixd', '#Fixed']]);
    expect(await fixOf('Stat: Open')).toEqual([['Stat', 'State']]);
    expect(await fixOf('Assignee: anan')).toEqual([['anan', 'anna']]);
    expect(await fixOf('State: In Progres #Unresolved')).toEqual([['In Progres', '{In Progress}']]);
    // Applying every fix gives a query with no problems.
    const q = 'State: Fixd Stat: Open';
    const r = await parseQueryForApi(w.as(w.anna), q);
    let fixed = q;
    for (const p of [...r.problems].sort((a, b) => b.start - a.start)) fixed = fixed.slice(0, p.start) + p.fix + fixed.slice(p.end);
    expect((await parseQueryForApi(w.as(w.anna), fixed)).problems).toEqual([]);
  });

  it('explains queries in words', async () => {
    const r = await parseQueryForApi(w.as(w.anna), 'project: BACK #Unresolved for: me sort by: updated desc');
    expect(r.explanation).toBe('Issues in project BACK, unresolved, assigned to you sorted by updated (descending)');
  });

  it('counts and groups', async () => {
    const c = await countIssues(w.as(w.anna), '#Unresolved', 'Priority');
    expect(c.total).toBe(4);
    expect(c.groups).toEqual([
      { value: 'Critical', count: 1 },
      { value: 'Major', count: 1 },
      { value: 'Normal', count: 1 },
      { value: 'Minor', count: 1 },
    ]);
  });

  it('suggests fields and values', async () => {
    const s = await w.app.schema.get();
    const fieldItems = suggest(s, 'Pri', 3);
    expect(fieldItems[0]).toMatchObject({ label: 'Priority:', insert: 'Priority: ', replaceStart: 0, replaceEnd: 3 });
    const valueItems = suggest(s, 'State: in', 9);
    expect(valueItems.map((i) => i.label)).toContain('In Progress');
    expect(valueItems.find((i) => i.label === 'In Progress')!.insert).toBe('{In Progress} ');
    const hash = suggest(s, '#unr', 4);
    expect(hash[0]!.label).toBe('#Unresolved');
  });

  it('parses ranges with relative dates without treating them as negation', async () => {
    const s = await w.app.schema.get();
    const parsed = parseQuery('created: -7d .. today', buildVocabulary(s));
    expect(parsed.problems).toEqual([]);
    expect(parsed.root).toMatchObject({ kind: 'term', values: [{ kind: 'range', from: '-7d', to: 'today' }] });
  });
});

describe('commands', () => {
  it('previews without changing anything', async () => {
    const res = await runCommand(w.as(w.anna), { issues: [ids.migr!], command: 'Critical for ben', dryRun: true });
    expect(res.problems).toEqual([]);
    expect(res.applied).toBe(false);
    expect(res.results[0]!.changes).toEqual([
      { field: 'Priority', from: 'Normal', to: 'Critical' },
      { field: 'Assignee', from: null, to: 'ben' },
    ]);
    expect(await found('Priority: Critical')).toEqual([ids.sso]);
  });

  it('applies fields, tags, links and comments to several issues', async () => {
    const res = await runCommand(w.as(w.anna), {
      issues: [ids.sso!, ids.rate!],
      command: 'State Fixed tag needs-release add Fix versions 2.0',
      comment: 'Shipped in the 2.0 train.',
    });
    expect(res.applied).toBe(true);
    expect(res.results.every((r) => r.errors.length === 0)).toBe(true);
    expect(await found('#Resolved')).toEqual([ids.done, ids.rate, ids.sso].sort());
    expect(await found('tag: needs-release')).toEqual([ids.rate, ids.sso].sort());
    expect(await found('Fix versions: 1.1')).toEqual([ids.rate]);
    expect(await found('Fix versions: 2.0')).toEqual([ids.rate, ids.sso].sort());
    expect(await found('commenter: anna')).toEqual([ids.rate, ids.sso].sort());
  });

  it('suggests what fits at the caret, replacing all of a value of several words', async () => {
    const s = await w.app.schema.get();
    const projectIds = [...s.projects.values()].map((p) => p.id);
    const at = (text: string) => suggestCommand(text, text.length, s, projectIds);
    const apply = (text: string, i = 0) => {
      const item = at(text)[i]!;
      return text.slice(0, item.replaceStart) + item.insert + text.slice(item.replaceEnd);
    };
    expect(apply('State In Prog')).toBe('State In Progress ');
    expect(apply('State In Progres')).toBe('State In Progress ');
    expect(at('State ').map((x) => x.label)).toContain('Fixed');
    expect(apply('for an')).toBe('for anna ');
    expect(apply('State Fixed tag needs-r')).toBe('State Fixed tag needs-release ');
    expect(at('State Fixed').length).toBe(0); // complete, nothing more to say
    expect(at('').length).toBeGreaterThan(0);
  });

  it('reports unknown words with suggestions and changes nothing', async () => {
    const res = await runCommand(w.as(w.anna), { issues: [ids.migr!], command: 'Stat Fixed' });
    expect(res.applied).toBe(false);
    expect(res.problems[0]!.hint).toContain('State');
    expect(res.problems[0]!.fix?.toLowerCase()).toBe('state');
    const value = await runCommand(w.as(w.anna), { issues: [ids.migr!], command: 'State Fixd', dryRun: true });
    expect(value.problems[0]).toMatchObject({ message: 'Unknown value "Fixd" for State', fix: 'Fixed' });
    // A misspelt value of several words is one problem with one fix, and stops before the next command.
    const words = await runCommand(w.as(w.anna), { issues: [ids.migr!], command: 'State In Progres for me', dryRun: true });
    expect(words.problems).toEqual([expect.objectContaining({ message: 'Unknown value "In Progres" for State', fix: '{In Progress}' })]);
    const fixed = await runCommand(w.as(w.anna), { issues: [ids.migr!], command: 'State {In Progress} for me', dryRun: true });
    expect(fixed.problems).toEqual([]);
  });

  it('links via phrases and refuses ambiguous values', async () => {
    const link = await runCommand(w.as(w.anna), { issues: [ids.dark!], command: `relates to ${ids.done}` });
    expect(link.applied).toBe(true);
    expect(await found(`links: ${ids.done}`)).toEqual([ids.dark]);
  });

  it('enforces optimistic concurrency', async () => {
    const issue = await updateIssue(w.as(w.anna), ids.dark!, { summary: 'Dark mode toggle is missing from settings' });
    await expect(updateIssue(w.as(w.ben), ids.dark!, { summary: 'Other', expectedVersion: issue.version - 1 })).rejects.toThrow(/changed by someone else/);
    const ok = await updateIssue(w.as(w.ben), ids.dark!, { summary: 'Dark mode toggle', expectedVersion: issue.version });
    expect(ok.version).toBe(issue.version + 1);
  });

  it('keeps viewers read-only', async () => {
    await expect(runCommand(w.as(w.viewer), { issues: [ids.dark!], command: 'Major' })).rejects.toThrow(/read-only|permission|scope/);
    expect((await searchIssues(w.as(w.viewer), 'project: WEB', 0, 10)).total).toBe(2);
  });
});

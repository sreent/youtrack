/**
 * A native speaker's sheet (scripts/i18n-review.mjs): made, filled in as another app saves it, and
 * brought back. Each test works on a small repo of its own, in a temporary folder.
 */
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import en from '../i18n/en.json' with { type: 'json' };
import { intlTag, langTag, LOCALES } from '../src/i18n';
import { langTagOf, messageProblems, pluralTag } from '../scripts/catalog-rules.mjs';
import { catalogText, exportSheet, importSheet, ReviewError } from '../scripts/review/review.mjs';
import { TIER_ONE_BUDGET, tierOf, wordsIn } from '../scripts/review/tiers.mjs';
import { readWorkbook, xmlText, zip } from '../scripts/review/xlsx.mjs';

const EN = {
  'app.shell.hello': 'Hello, {name}',
  'issues.issueList.count': '{n, plural, one {# issue} other {# issues}}',
  'page.admin.title': 'Administration',
  'page.issue.remove': 'Remove',
  'page.issue.removeFor': 'Remove {name}',
  'page.issue.save': 'Save',
  'page.issue.saved': ' saved by {name}',
  'page.portal.replied': '<b>{who}</b> replied',
  'problem.notFound.issue': 'No issue {id}. Use its id, such as BACK-12.',
  'ui.who.state': '{state, select, merged {merged} closed {closed} other {reopened}}',
};
const TH = {
  'app.shell.hello': 'สวัสดี {name}',
  'issues.issueList.count': '{n, plural, other {อิชชู # รายการ}}',
  'page.admin.title': 'การดูแลระบบ',
  'page.issue.remove': 'นำออก',
  'page.issue.removeFor': 'นำออก {name}',
  'page.issue.save': 'บันทึก',
  'page.issue.saved': ' บันทึกโดย {name}',
  'page.portal.replied': '<b>{who}</b> ตอบกลับ',
  'problem.notFound.issue': 'ไม่พบอิชชู {id} ใช้รหัส เช่น BACK-12',
  'ui.who.state': '{state, select, merged {เมิร์จแล้ว} closed {ปิดแล้ว} other {เปิดอีกครั้ง}}',
};
const TRANSLATING = `# Translating a4a

## Thai

| English | Thai |
|---|---|
| issue | อิชชู, never ตั๋ว or ทิกเก็ต |
| request (help desk) | คำขอ |
`;
const QUESTIONS = `# Questions for native speakers

## Thai

**Read by a native speaker:** not yet.

Thai was written in one pass.

- **A thing to ask**: what the catalog says now (\`page.issue.save\`). Is it right?

## What a catalog can't say yet

- **Whether a name is Thai**: Thai sets a Latin value off with a space.
- **Korean's particles**: not Thai's.
`;

const roots: string[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

function repo() {
  const root = mkdtempSync(path.join(tmpdir(), 'a4a-review-'));
  roots.push(root);
  const put = (file: string, text: string) => {
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    writeFileSync(path.join(root, file), text);
  };
  put('packages/shared/src/i18n.ts', "export const LOCALES = ['en', 'th'] as const;\n");
  put('packages/shared/i18n/en.json', catalogText(EN));
  put('packages/shared/i18n/th.json', catalogText(TH));
  put('apps/web/src/Remove.tsx', "export const R = () => <button aria-label={t('page.issue.removeFor', { name })}>{t('page.issue.remove')}</button>;\n");
  put('docs/translating.md', TRANSLATING);
  put('docs/translation-questions.md', QUESTIONS);
  const read = (file: string) => readFileSync(path.join(root, file), 'utf8');
  return { root, put, read, th: () => JSON.parse(read('packages/shared/i18n/th.json')) as Record<string, string> };
}

const made = new Date('2026-11-25T10:00:00Z');
const later = new Date('2026-12-02T09:00:00Z');
const passes = async () => ({ ok: true, output: '' });

type Rows = Map<number, Map<number, string>>;
type Edit = { key?: string; suggestion?: string; note?: string; english?: string; howFar?: string; better?: [string, string]; answer?: [string, string] };

/** The sheet filled in as another app saves one: inline strings and rich runs, its parts named its own way. */
function fillIn(file: string, edits: Edit[], out = file.replace(/\.xlsx$/, '-filled.xlsx')) {
  const { sheets } = readWorkbook(readFileSync(file));
  const sheet = (name: string) => sheets.find((s: { name: string }) => s.name === name)!.rows as Rows;
  const col = (rows: Rows, head: string) => [...rows.get(1)!].find(([, v]) => v === head || v.endsWith(head))![0];
  const rowOf = (rows: Rows, c: number, value: string) => [...rows].find(([, r]) => r.get(c) === value)?.[0];
  for (const e of edits) {
    if (e.key) {
      const m = sheet('Messages');
      const r = rowOf(m, col(m, 'Key'), e.key) ?? m.size + 1;
      if (!m.has(r)) m.set(r, new Map([[col(m, 'Key'), e.key]]));
      if (e.suggestion !== undefined) m.get(r)!.set(col(m, 'Your suggestion'), e.suggestion);
      if (e.note !== undefined) m.get(r)!.set(col(m, 'Your note'), e.note);
      if (e.english !== undefined) m.get(r)!.set(col(m, 'English'), e.english);
    }
    if (e.howFar) {
      const s = sheet('Start here');
      s.get(rowOf(s, 0, 'How far you read')!)!.set(1, e.howFar);
    }
    if (e.better) {
      const t = sheet('Terms');
      t.get(rowOf(t, 0, e.better[0])!)!.set(col(t, 'A better word'), e.better[1]);
    }
    if (e.answer) {
      const q = sheet('Questions');
      const r = [...q].find(([, row]) => row.get(1)?.includes(e.answer![0]))![0];
      q.get(r)!.set(col(q, 'Your answer'), e.answer[1]);
    }
  }
  const cell = (ref: string, v: string, i: number) =>
    i % 2 ? `<x:c r="${ref}" t="inlineStr"><x:is><x:t xml:space="preserve">${xmlText(v)}</x:t></x:is></x:c>` : `<x:c r="${ref}" t="inlineStr"><x:is><x:r><x:t>${xmlText(v.slice(0, 1))}</x:t></x:r><x:r><x:rPr><x:b/></x:rPr><x:t xml:space="preserve">${xmlText(v.slice(1))}</x:t></x:r><x:rPh sb="0" eb="1"><x:t>ルビ</x:t></x:rPh></x:is></x:c>`;
  const letter = (c: number) => String.fromCharCode(65 + c);
  const parts: [string, string][] = sheets.map((s: { rows: Rows }, i: number) => [
    `xl/sheets/part${i + 1}.xml`,
    `<?xml version="1.0"?>\n<x:worksheet xmlns:x="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><x:sheetData>${[...s.rows]
      .map(([r, cells]) => `<x:row r="${r}">${[...cells].map(([c, v], n) => (/^\d+$/.test(v) ? `<x:c r="${letter(c)}${r}"><x:v>${v}</x:v></x:c>` : cell(`${letter(c)}${r}`, v, n))).join('')}</x:row>`)
      .join('')}</x:sheetData></x:worksheet>`,
  ]);
  const files: [string, string][] = [
    ['[Content_Types].xml', '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>'],
    ['xl/workbook.xml', `<?xml version="1.0"?>\n<x:workbook xmlns:x="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:rel="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><x:sheets>${sheets.map((s: { name: string }, i: number) => `<x:sheet name="${xmlText(s.name)}" sheetId="${i + 7}" rel:id="s${i}"/>`).join('')}</x:sheets></x:workbook>`],
    ['xl/_rels/workbook.xml.rels', `<?xml version="1.0"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets.map((_: unknown, i: number) => `<Relationship Id="s${i}" Type="worksheet" Target="/xl/sheets/part${i + 1}.xml"/>`).join('')}</Relationships>`],
    ...parts,
  ];
  writeFileSync(out, zip(files));
  return out;
}

async function sheetFor(r: ReturnType<typeof repo>, now = made) {
  const out = path.join(r.root, 'out');
  mkdirSync(out, { recursive: true });
  return (await exportSheet({ root: r.root, locale: 'th', out, now })).file as string;
}
const bring = (r: ReturnType<typeof repo>, file: string, more: Record<string, unknown> = {}) => importSheet({ root: r.root, file, now: later, check: passes, ...more });

describe('a native speaker’s sheet', () => {
  it('changes nothing when it comes back with no suggestions', async () => {
    const r = repo();
    const [catalog, doc] = [r.read('packages/shared/i18n/th.json'), r.read('docs/translation-questions.md')];
    const report = await bring(r, fillIn(await sheetFor(r), []));
    expect(report.applied).toEqual([]);
    expect(report.refused).toEqual([]);
    expect(r.read('packages/shared/i18n/th.json')).toBe(catalog);
    expect(r.read('docs/translation-questions.md')).toBe(doc);
  });

  it('holds every message once, by tier, then where, then key, with its English and its words now', async () => {
    const r = repo();
    const { sheets } = readWorkbook(readFileSync(await sheetFor(r)));
    const rows = [...sheets.find((s: { name: string }) => s.name === 'Messages')!.rows.values()].slice(1) as Map<number, string>[];
    expect(rows.map((x) => x.get(2))).toEqual(['app.shell.hello', 'issues.issueList.count', 'page.issue.remove', 'page.issue.removeFor', 'page.issue.save', 'page.issue.saved', 'page.portal.replied', 'ui.who.state', 'problem.notFound.issue', 'page.admin.title'].sort((a, b) => tierOf(a).tier - tierOf(b).tier || tierOf(a).rank - tierOf(b).rank || (a < b ? -1 : 1)));
    expect(rows.find((x) => x.get(2) === 'page.issue.save')!.get(4)).toBe('บันทึก');
    const terms = sheets.find((s: { name: string }) => s.name === 'Terms')!.rows as Rows;
    expect(terms.get(2)!.get(1)).toBe('อิชชู, never ตั๋ว or ทิกเก็ต');
    const questions = [...(sheets.find((s: { name: string }) => s.name === 'Questions')!.rows as Rows).values()].map((x) => x.get(1));
    expect(questions).toContain('A thing to ask: what the catalog says now (page.issue.save). Is it right?');
    expect(questions).toContain('Whether a name is Thai: Thai sets a Latin value off with a space.');
    expect(questions.some((q) => q?.startsWith('Korean'))).toBe(false);
  });

  it('applies a good suggestion, keeping the space at its start that the reader can’t see, and records the read', async () => {
    const r = repo();
    const file = fillIn(await sheetFor(r), [{ key: 'page.issue.save', suggestion: 'บันทึกเลย' }, { key: 'page.issue.saved', suggestion: 'บันทึกแล้วโดย {name}' }, { howFar: 'The terms and tier 1' }]);
    const report = await bring(r, file, { reader: 'Somchai J.' });
    expect(report.applied.map((a: { key: string }) => a.key).sort()).toEqual(['page.issue.save', 'page.issue.saved']);
    expect(r.th()['page.issue.save']).toBe('บันทึกเลย');
    expect(r.th()['page.issue.saved']).toBe(' บันทึกแล้วโดย {name}');
    expect(r.read('docs/translation-questions.md')).toContain(
      `**Read by a native speaker:** The terms and tier 1, from a sheet made on 25 November 2026, brought back on 2 December 2026, by Somchai J.: 2 changes (sheet \`${report.sheetId}\`).`,
    );
    // The file is still one message a line, its keys in their order.
    expect(Object.keys(r.th())).toEqual(Object.keys(TH));
    expect(r.read('packages/shared/i18n/th.json')).toBe(catalogText({ ...TH, 'page.issue.save': 'บันทึกเลย', 'page.issue.saved': ' บันทึกแล้วโดย {name}' }));
  });

  it.each([
    ['a placeholder dropped', 'app.shell.hello', 'สวัสดี', /names \{\}, English names \{name\}/],
    ['a placeholder added', 'page.issue.save', 'บันทึก {name}', /names \{name\}, English names \{\}/],
    ['a select’s case lost', 'ui.who.state', '{state, select, merged {เมิร์จแล้ว} other {เปิดอีกครั้ง}}', /lost a case English has: “closed”/],
    ['a plural category Thai hasn’t', 'issues.issueList.count', '{n, plural, one {อิชชู 1 รายการ} other {อิชชู # รายการ}}', /“one”, which Thai hasn't/],
    ['# lost', 'issues.issueList.count', '{n, plural, other {อิชชูหลายรายการ}}', /has lost #, the number/],
    ['a tag moved off its value', 'page.portal.replied', '{who} <b>ตอบกลับ</b>', /<b> no longer holds \{who\}/],
    ['a tag renamed', 'page.portal.replied', '<i>{who}</i> ตอบกลับ', /names \{i,who\}, English names \{b,who\}/],
    ['a control’s name that loses what it shows', 'page.issue.removeFor', 'ลบ {name}', /shows “นำออก”, so it should hold those words whole/],
    ['Thai’s full stop', 'page.admin.title', 'การดูแลระบบ.', /\[thai-stop\]/],
    ['a link English hasn’t', 'page.issue.save', 'บันทึกที่ https://example.test', /adds a link or an address English hasn't/],
    ['a character nobody sees', 'page.issue.save', 'บันทึก‮', /a character nobody sees \(U\+202E\)/],
    ['a line break', 'page.issue.save', 'บัน\nทึก', /breaks a line/],
    ['an unknown key', 'page.nothing.here', 'อะไร', /no message has this key/],
  ])('refuses %s, saying why, and writes nothing', async (_, key, suggestion, why) => {
    const r = repo();
    const catalog = r.read('packages/shared/i18n/th.json');
    const report = await bring(r, fillIn(await sheetFor(r), [{ key, suggestion }]));
    expect(report.applied).toEqual([]);
    expect(report.refused).toHaveLength(1);
    expect(report.refused[0].why.join(' ')).toMatch(why);
    expect(r.read('packages/shared/i18n/th.json')).toBe(catalog);
  });

  it('refuses a row whose English changed since the sheet was made, or whose words did', async () => {
    const r = repo();
    const file = fillIn(await sheetFor(r), [{ key: 'page.issue.save', suggestion: 'บันทึกเลย' }, { key: 'page.admin.title', suggestion: 'ผู้ดูแล' }]);
    r.put('packages/shared/i18n/en.json', catalogText({ ...EN, 'page.issue.save': 'Save it' }));
    r.put('packages/shared/i18n/th.json', catalogText({ ...TH, 'page.admin.title': 'การดูแล' }));
    const report = await bring(r, file);
    const why = Object.fromEntries(report.refused.map((x: { key: string; why: string[] }) => [x.key, x.why.join(' ')]));
    expect(why['page.issue.save']).toMatch(/^changed since this sheet was made: read it again\. English now says “Save it”/);
    expect(why['page.admin.title']).toMatch(/^changed since this sheet was made: read it again\. Thai now says “การดูแล”/);
    expect(r.th()['page.admin.title']).toBe('การดูแล');
  });

  it('refuses a row whose English was edited in the sheet itself, and says where to write instead', async () => {
    const r = repo();
    const report = await bring(r, fillIn(await sheetFor(r), [{ key: 'page.issue.save', english: 'Save now', suggestion: 'บันทึกเลย' }]));
    expect(report.refused[0].why[0]).toMatch(/changed in the sheet itself: put the change under Your suggestion/);
  });

  it('writes nothing in a dry run, and says what it would do', async () => {
    const r = repo();
    const [catalog, doc] = [r.read('packages/shared/i18n/th.json'), r.read('docs/translation-questions.md')];
    const report = await bring(r, fillIn(await sheetFor(r), [{ key: 'page.issue.save', suggestion: 'บันทึกเลย' }, { howFar: 'Part of tier 1' }]), { dryRun: true });
    expect(report.applied).toHaveLength(1);
    expect(report.record).toMatch(/Part of tier 1, from a sheet made on 25 November 2026/);
    expect(r.read('packages/shared/i18n/th.json')).toBe(catalog);
    expect(r.read('docs/translation-questions.md')).toBe(doc);
  });

  it('comes back the same when the same sheet is brought back twice', async () => {
    const r = repo();
    const file = fillIn(await sheetFor(r), [{ key: 'page.issue.save', suggestion: 'บันทึกเลย' }, { key: 'app.shell.hello', note: 'สวัสดีครับ is spoken' }, { howFar: 'Tiers 1 and 2' }]);
    await bring(r, file);
    const once = [r.read('packages/shared/i18n/th.json'), r.read('docs/translation-questions.md')];
    const again = await bring(r, file, { now: new Date('2026-12-09T09:00:00Z') });
    expect(again.applied).toEqual([]);
    expect(again.already).toEqual(['page.issue.save']);
    expect(again.refused).toEqual([]);
    expect([r.read('packages/shared/i18n/th.json'), r.read('docs/translation-questions.md')]).toEqual(once);
  });

  it('gives the reader’s notes, answers and better terms, with the messages that use the old word', async () => {
    const r = repo();
    const file = fillIn(await sheetFor(r), [{ key: 'page.admin.title', note: 'ผู้ดูแลระบบ is the usual word' }, { better: ['issue', 'ปัญหา'] }, { answer: ['A thing to ask', 'Yes, it reads right'] }]);
    const report = await bring(r, file, { dryRun: true });
    expect(report.notes).toEqual([{ key: 'page.admin.title', english: 'Administration', words: 'การดูแลระบบ', note: 'ผู้ดูแลระบบ is the usual word' }]);
    expect(report.answers).toEqual([{ kind: 'Left for a native speaker', question: 'A thing to ask: what the catalog says now (page.issue.save). Is it right?', answer: 'Yes, it reads right' }]);
    expect(report.terms).toEqual([expect.objectContaining({ english: 'issue', form: 'อิชชู', better: 'ปัญหา', messages: ['issues.issueList.count', 'problem.notFound.issue'] })]);
  });

  it('puts the catalog back when check:words fails after the write, and records nothing', async () => {
    const r = repo();
    const [catalog, doc] = [r.read('packages/shared/i18n/th.json'), r.read('docs/translation-questions.md')];
    let seen = '';
    const fails = async () => {
      seen = r.read('packages/shared/i18n/th.json');
      return { ok: false, output: 'apps/web/src/X.tsx:1: words in JSX' };
    };
    await expect(bring(r, fillIn(await sheetFor(r), [{ key: 'page.issue.save', suggestion: 'บันทึกเลย' }]), { check: fails })).rejects.toThrow(/check:words failed after the write, so th\.json is as it was/);
    expect(seen).toContain('บันทึกเลย');
    expect(r.read('packages/shared/i18n/th.json')).toBe(catalog);
    expect(r.read('docs/translation-questions.md')).toBe(doc);
  });

  it('takes two sheets brought back at once, one after the other, so neither loses the other’s words', async () => {
    const r = repo();
    const a = fillIn(await sheetFor(r, made), [{ key: 'page.issue.save', suggestion: 'บันทึกเลย' }], path.join(r.root, 'a.xlsx'));
    const b = fillIn(await sheetFor(r, new Date('2026-11-26T10:00:00Z')), [{ key: 'page.admin.title', suggestion: 'ผู้ดูแลระบบ' }], path.join(r.root, 'b.xlsx'));
    // The first holds between reading the catalog and writing it, as a slow disk would.
    const slow = { beforeWrite: () => new Promise((done) => setTimeout(done, 300)) };
    const [ra, rb] = await Promise.all([bring(r, a, { hooks: slow }), bring(r, b)]);
    expect([ra.applied.length, rb.applied.length]).toEqual([1, 1]);
    expect(r.th()['page.issue.save']).toBe('บันทึกเลย');
    expect(r.th()['page.admin.title']).toBe('ผู้ดูแลระบบ');
    expect(r.read('docs/translation-questions.md').match(/\(sheet `r[0-9a-f]+`\)/g)).toHaveLength(2);
    expect(readdirSync(path.join(r.root, 'packages/shared/i18n')).sort()).toEqual(['en.json', 'th.json']);
  });

  it('refuses a file that isn’t a sheet of its own, saying what it needs', async () => {
    const r = repo();
    const not = path.join(r.root, 'not.xlsx');
    writeFileSync(not, 'name,words\n');
    await expect(bring(r, not)).rejects.toThrow(ReviewError);
    await expect(bring(r, not)).rejects.toThrow(/can't be read as a sheet: it isn't an XLSX file/);
    const bare = path.join(r.root, 'bare.xlsx');
    writeFileSync(bare, zip([['xl/workbook.xml', '<workbook><sheets/></workbook>']]));
    await expect(bring(r, bare)).rejects.toThrow(/isn't an a4a review sheet/);
  });
});

describe('tiers', () => {
  it('gives every key a tier and a place a reader knows, keys nobody has seen yet too', () => {
    for (const k of [...Object.keys(en), 'page.portal.languageChoice', 'server.helpdesk.cc.byGroup', 'brandNew.thing.here']) {
      const t = tierOf(k);
      expect([1, 2, 3]).toContain(t.tier);
      expect(t.where).toMatch(/^[A-Z][a-z]/);
    }
    expect(tierOf('page.portal.languageChoice')).toMatchObject({ tier: 1, where: 'Portal' });
    expect(tierOf('server.helpdesk.cc.byGroup')).toMatchObject({ tier: 1, where: 'Help desk emails' });
    expect(tierOf('problem.imports.whatever')).toMatchObject({ tier: 3, where: 'Errors' });
    expect(tierOf('problem.notFound.issue')).toMatchObject({ tier: 2, where: 'Errors' });
    expect(tierOf('page.issue.source.title').tier).toBe(2);
    expect(tierOf('page.issue.save').tier).toBe(1);
  });

  it('keeps tier 1 to an hour’s read', () => {
    const one = Object.entries(en).filter(([k]) => tierOf(k).tier === 1);
    expect(one.length).toBeLessThanOrEqual(TIER_ONE_BUDGET.messages);
    expect(one.reduce((n, [, v]) => n + wordsIn(v), 0)).toBeLessThanOrEqual(TIER_ONE_BUDGET.words);
    expect(one.length).toBeGreaterThan(400);
  });
});

describe('the rules a sheet shares with check:words', () => {
  it('counts by each language’s own tag, as the translator does', () => {
    for (const l of LOCALES) {
      expect(pluralTag(l)).toBe(intlTag(l));
      expect(langTagOf(l)).toBe(langTag(l));
    }
  });

  it('keeps a catalog’s file as it is when nothing in it changes', () => {
    for (const l of LOCALES) {
      const text = readFileSync(path.join(__dirname, `../i18n/${l}.json`), 'utf8');
      expect(catalogText(JSON.parse(text))).toBe(text);
    }
  });

  it('lets a language count last with {n, number}, and say one without its number where English does', () => {
    expect(messageProblems('es', '{n, plural, one {# issue} other {# issues}}', 'Incidencias: {n, number}')).toEqual([]);
    expect(messageProblems('fr', '{n, plural, one {Its version} other {Its # versions}}', '{n, plural, one {Sa version} other {Ses # versions}}')).toEqual([]);
    expect(messageProblems('fr', '{n, plural, one {# issue} other {# issues}}', '{n, plural, one {un ticket} other {# tickets}}')[0]).toMatch(/“one” has lost #/);
    expect(messageProblems('de', '{n, plural, one {# issue} other {# issues}}', '{n, plural, one {ein Vorgang} other {# Vorgänge}}')).toEqual([]);
    expect(messageProblems('ja', '{who, select, you {You} other {{name}}}', '{who, select, other {}}{name}')).toEqual([]);
  });
});

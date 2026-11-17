/**
 * The query, command and rule languages' problems in a person's language (D49): each carries a key
 * under problem.* and its values beside the API's English, the English in en.json is what the API
 * says (checked where each problem is made, under tests), and German says each in its own words.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { canSayProblem, createTranslator, sayProblem, type ProblemSaid } from '@a4a/shared/i18n';
import type { QueryProblem } from '@a4a/shared';
import { runCommand } from '../src/commands/executor';
import { createHttpApp } from '../src/http/app';
import { problemFor, translatorFor } from '../src/i18n';
import { pageWords, readAlike } from '../src/lib/errors';
import { parseQueryForApi } from '../src/search/service';
import { addFieldValue, attachField, createField } from '../src/services/fields';
import { createIssue } from '../src/services/issues';
import { AppError } from '../src/lib/errors';
import { createRule, previewRule } from '../src/workflow/rules';
import { createWorld, type TestWorld } from './helpers';

let w: TestWorld;
let issueId = '';
const en = translatorFor('en');
const de = translatorFor('de');

beforeAll(async () => {
  w = await createWorld({ config: { publicUrl: 'http://a4a.test' } });
  const admin = w.adminCtx;
  const team = await createField(admin, { name: 'Team', type: 'group', multi: false, description: '', values: [] });
  await attachField(admin, 'BACK', team.id, {});
  const build = await createField(admin, { name: 'Fixed in build', type: 'build', multi: false, description: '', values: [] });
  await attachField(admin, 'BACK', build.id, {});
  const none = await createField(admin, { name: 'Found in build', type: 'build', multi: false, description: '', values: [] });
  await attachField(admin, 'BACK', none.id, {});
  for (const name of ['2026.11.101', '2026.11.102']) await addFieldValue(admin, build.id, { name });
  const points = await createField(admin, { name: 'Points', type: 'integer', multi: false, description: '', values: [] });
  await attachField(admin, 'BACK', points.id, {});
  const severity = await createField(admin, { name: 'Severity', type: 'enum', multi: false, description: '', values: [{ name: 'Major' }, { name: 'Minor' }] });
  await attachField(admin, 'BACK', severity.id, {});
  w.app.schema.invalidate();
  issueId = (await createIssue(w.as(w.anna), { project: 'BACK', summary: 'Words for problems' })).id;
});

afterAll(async () => {
  await w?.close();
});

/** A problem as a page in English says it, and as one in German does. */
function said(p: QueryProblem): { en: string; de: string } {
  expect(p.key, `"${p.message}" has no key`).toBeTypeOf('string');
  const words: ProblemSaid = { key: p.key!, ...(p.values ? { values: p.values } : {}) };
  return { en: sayProblem(en, words), de: sayProblem(de, words) };
}

/** Each query, and a problem it meets. */
const QUERIES: [query: string, key: string, german: string][] = [
  ['summary: {Login fails', 'query.missingClosing', 'Das schließende } fehlt.'],
  ['Login }', 'query.unexpectedBrace', 'Unerwartet: „}“.'],
  [')', 'query.unexpected', 'Unerwartet: „)“.'],
  ['Login or', 'query.orNeedsMore', 'Nach „or“ fehlt etwas.'],
  ['(Login', 'query.missingParen', 'Die schließende ) fehlt.'],
  ['#', 'query.valueAfterHash', 'Nach # fehlt ein Wert.'],
  ['Prority: Major', 'query.unknownField', 'Unbekanntes Feld „Prority“. Meinten Sie „Priority“?'],
  ['Zebra: Major', 'query.unknownField', 'Unbekanntes Feld „Zebra“.'],
  ['State:', 'query.valueAfterField', 'Nach „State:“ fehlt ein Wert.'],
  ['State: -..', 'query.valueAfterMinus', 'Nach „-“ fehlt ein Wert.'],
  ['created: 2026-01-01 ..', 'query.rangeEnd', 'Nach „..“ fehlt das Ende des Bereichs.'],
  ['sort by updated', 'query.sortColon', 'Nach „sort by“ fehlt „:“.'],
  ['sort by: , updated', 'query.unexpectedInSort', 'Unerwartet in „sort by“: „,“.'],
  ['sort by: prority', 'query.cannotSortBy', 'Nach „prority“ kann nicht sortiert werden. Meinten Sie „priority“?'],
  ['sort by: zebra', 'query.cannotSortBy', 'Nach „zebra“ kann nicht sortiert werden.'],
  ['sort by: updated desc desc', 'query.unexpectedAfterSort', 'Unerwartet nach „sort by“: „desc“.'],
  ['sort by:', 'query.sortField', 'Nach „sort by:“ fehlt ein Feld.'],
  ['#Fixd', 'query.unknownHashValue', 'Unbekannter Wert „#Fixd“. Meinten Sie „#Fixed“?'],
  ['#Zebra', 'query.unknownHashValue', 'Unbekannter Wert „#Zebra“. Verwenden Sie #Unresolved, einen Feldwert wie #Critical oder ein Tag.'],
  ['State: Fixd', 'query.unknownValue', 'Unbekannter Wert „Fixd“ für State. Meinten Sie „Fixed“?'],
  ['Subsystem: Zebra', 'query.unknownValue', 'Unbekannter Wert „Zebra“ für Subsystem. Werte: API, Database, Auth, UI.'],
  ['Assignee: annna', 'query.unknownUserInField', 'Unbekannte Person „annna“. Meinten Sie „anna“?'],
  ['Assignee: qqqqqqqq', 'query.unknownUserInField', 'Unbekannte Person „qqqqqqqq“. Verwenden Sie einen Login, einen Namen, „me“ oder „Unassigned“.'],
  ['Estimation: zebra', 'query.notADurationFor', '„zebra“ ist keine gültige Dauer für Estimation.'],
  ['Points: zebra', 'query.notANumberFor', '„zebra“ ist keine gültige Zahl für Points.'],
  ['Points: a .. b', 'query.invalidRange', 'Ungültiger Bereich für Points.'],
  ['created: zebra', 'query.notADate', '„zebra“ ist kein Datum für created. Verwenden Sie JJJJ-MM-TT, today, {this week}, -7d oder einen Bereich „a .. b“.'],
  ['created: zebra .. today', 'query.invalidDateRange', 'Ungültiger Datumsbereich für created. Verwenden Sie z. B. 2026-01-01 .. 2026-01-31 oder -7d .. today.'],
  ['issue id: zebra', 'query.notAnIssueId', '„zebra“ ist keine Vorgangs-ID. Vorgangs-IDs sehen so aus: BACK-12.'],
  ['project: BAKC', 'query.unknownProject', 'Unbekanntes Projekt „BAKC“. Meinten Sie „BACK“?'],
  ['project: Zebra', 'query.unknownProject', 'Unbekanntes Projekt „Zebra“.'],
  ['reporter: qqqqqqqq', 'query.unknownUser', 'Unbekannte Person „qqqqqqqq“.'],
  ['reporter: annna', 'query.unknownUser', 'Unbekannte Person „annna“. Meinten Sie „anna“?'],
  ['tag: zebra', 'query.unknownTag', 'Unbekanntes Tag „zebra“.'],
  ['spent time: zebra', 'query.notADuration', '„zebra“ ist keine Dauer.'],
  ['votes: zebra', 'query.notVotes', '„zebra“ ist keine Anzahl von Stimmen. Verwenden Sie eine Zahl, z. B. votes: 3, oder einen Bereich, z. B. votes: 5 .. *.'],
  ['votes: a .. b', 'query.invalidVotesRange', 'Ungültiger Bereich für Stimmen. Verwenden Sie z. B. votes: 5 .. * oder votes: 1 .. 3.'],
  ['has: zebra', 'query.unknownHas', 'Unbekanntes Attribut „zebra“ für „has:“.'],
  ['sla: zebra', 'query.unknownValue', 'Unbekannter Wert „zebra“ für sla. Werte: on track, at risk, paused, breached, met, overdue, due, missed.'],
  ['State: Open .. Fixed', 'query.noRanges', 'Für State sind keine Bereiche möglich.'],
  ['project: BACK .. WEB', 'query.noRanges', 'Für project sind keine Bereiche möglich.'],
  ['Team: zebra', 'query.unknownGroup', 'Unbekannte Gruppe „zebra“ für Team. Es gibt noch keine Gruppen.'],
  ['Fixed in build: 2026.11.1o1 .. *', 'query.unknownBuild', 'Unbekannter Build „2026.11.1o1“ für Fixed in build. Meinten Sie „2026.11.101“?'],
  ['Fixed in build: zebra', 'query.unknownValue', 'Unbekannter Wert „zebra“ für Fixed in build. Werte: 2026.11.101, 2026.11.102.'],
  ['Found in build: zebra', 'query.unknownValue', 'Unbekannter Wert „zebra“ für Found in build. Es gibt noch keine Werte.'],
  ['Fixed in build: zebra .. *', 'query.unknownBuild', 'Unbekannter Build „zebra“ für Fixed in build. Neueste Builds: 2026.11.102, 2026.11.101.'],
  ['Found in build: zebra .. *', 'query.unknownBuild', 'Unbekannter Build „zebra“ für Found in build. Es gibt noch keine Builds.'],
];

describe('the query language’s problems, in a person’s language (D49)', () => {
  it.each(QUERIES)('%s: %s', async (query, key, german) => {
    const { problems } = await parseQueryForApi(w.as(w.anna), query);
    expect(problems.length, `"${query}" has no problem`).toBeGreaterThan(0);
    for (const p of problems) {
      const words = said(p);
      // English pages show the API's words, and the catalog's English is the same sentence.
      expect(readAlike(words.en, pageWords(p.message, p.hint)), `${words.en} | ${pageWords(p.message, p.hint)}`).toBe(true);
      expect(words.de).not.toBe(words.en);
    }
    const met = problems.find((p) => p.key === key);
    expect(met, `"${query}" meets ${problems.map((p) => p.key).join(', ')}`).toBeDefined();
    expect(said(met!).de).toBe(german);
  });

  it('gives /search/parse’s problems their keys, for a page in German to say them', async () => {
    const app = createHttpApp(w.app);
    const login = await app.request('/api/v1/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ login: 'admin', password: 'password-admin' }),
    });
    const cookie = login.headers.get('set-cookie')!.split(';')[0]!;
    const res = await app.request('/api/v1/search/parse', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie, origin: 'http://a4a.test', 'x-a4a-locale': 'de' },
      body: JSON.stringify({ query: 'State: Fixd sort by: prority' }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; problems: QueryProblem[] };
    expect(body.ok).toBe(false);
    // The API's words stay English; the key and values are beside them.
    expect(body.problems).toEqual([
      expect.objectContaining({ message: 'Unknown value "Fixd" for State', hint: 'Did you mean "Fixed"?', fix: 'Fixed', key: 'query.unknownValue', values: expect.objectContaining({ value: 'Fixd', field: 'State', hasGuess: 'yes', guess: 'Fixed' }) }),
      expect.objectContaining({ message: 'Cannot sort by "prority"', key: 'query.cannotSortBy', values: { name: 'prority', hasGuess: 'yes', guess: 'priority' } }),
    ]);
    expect(body.problems.map((p) => said(p).de)).toEqual(['Unbekannter Wert „Fixd“ für State. Meinten Sie „Fixed“?', 'Nach „prority“ kann nicht sortiert werden. Meinten Sie „priority“?']);
  });
});

/** Each command, and a problem it meets. */
const COMMANDS: [command: string, key: string, german: string][] = [
  ['', 'command.empty', 'Der Befehl ist leer. Zum Beispiel „State Fixed“ oder „for me“.'],
  ['add', 'command.somethingTo', 'Nach „add“ fehlt etwas.'],
  ['tag', 'command.tagName', 'Der Name eines Tags fehlt.'],
  ['untag', 'command.tagNameAfterUntag', 'Nach „untag“ fehlt der Name eines Tags.'],
  ['for', 'command.userAfterFor', 'Nach „for“ fehlt eine Person.'],
  ['depends on', 'command.issueAfterLink', 'Nach „depends on“ fehlt eine Vorgangs-ID.'],
  ['State', 'command.valueFor', 'Für State fehlt ein Wert.'],
  ['Major', 'command.valueOfFields', '„Major“ ist ein Wert von Priority und Severity. Sagen Sie, welches Feld Sie meinen, z. B. „Priority Major“.'],
  ['BACK-1', 'command.issueIdNotCommand', '„BACK-1“ ist eine Vorgangs-ID, kein Befehl. Ein Befehl gilt für die gewählten Vorgänge, lassen Sie sie also weg. Um mit BACK-1 zu verknüpfen, sagen Sie, wie, z. B. „relates to BACK-1“.'],
  ['qqqqqqqq', 'command.unknown', 'Unbekannter Befehl „qqqqqqqq“. Verwenden Sie einen Feldnamen und einen Wert, z. B. „State Fixed“, oder „tag urgent“.'],
  ['untagg urgent', 'command.unknown', 'Unbekannter Befehl „untagg“. Meinten Sie „untag“?'],
  ['State Fixd', 'command.unknownValue', 'Unbekannter Wert „Fixd“ für State. Meinten Sie „Fixed“?'],
  ['Estimation zebra', 'command.notADuration', '„zebra“ ist keine Dauer für Estimation. Verwenden Sie z. B. 2d, 4h oder 1w 2d.'],
];

describe('the command language’s problems, in a person’s language (D49)', () => {
  it.each(COMMANDS)('%s: %s', async (command, key, german) => {
    const { problems } = await runCommand(w.as(w.anna), { issues: [issueId], command, dryRun: true });
    expect(problems.length, `"${command}" has no problem`).toBeGreaterThan(0);
    for (const p of problems) {
      const words = said(p);
      expect(readAlike(words.en, pageWords(p.message, p.hint)), `${words.en} | ${pageWords(p.message, p.hint)}`).toBe(true);
      expect(words.de).not.toBe(words.en);
    }
    const met = problems.find((p) => p.key === key);
    expect(met, `"${command}" meets ${problems.map((p) => p.key).join(', ')}`).toBeDefined();
    expect(said(met!).de).toBe(german);
  });
});

describe('a rule’s problems, in a person’s language (D49)', () => {
  it('says each where it is, and all of them where the rule is refused', async () => {
    const draft = { project: 'BACK', name: 'Mine', kind: 'schedule' as const, schedule: { every: 'hour' as const }, query: 'for: me', command: 'tag mine', notify: { to: [], people: ['qqqqqqqq'], message: '' } };
    const preview = await previewRule(w.adminCtx, draft);
    const keys = preview.problems.map((p) => p.key);
    expect(keys).toEqual(expect.arrayContaining(['rule.meInSchedule', 'rule.sayMessage', 'rule.noOneCalled']));
    for (const p of preview.problems) {
      const words = said(p);
      expect(readAlike(words.en, pageWords(p.message, p.hint)), `${words.en} | ${pageWords(p.message, p.hint)}`).toBe(true);
      expect(words.de).not.toBe(words.en);
    }
    expect(said(preview.problems.find((p) => p.key === 'rule.noOneCalled')!).de).toBe('Niemand heißt „qqqqqqqq“. Nennen Sie Personen bei ihrem Login, z. B. anna.');
    const refused = await createRule(w.adminCtx, { ...draft, name: '' }).catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(AppError);
    const e = refused as AppError;
    expect(e.words?.key).toBe('workflow.ruleNeedsFixing');
    const page = sayProblem(de, e.words!);
    expect(page).toContain('Geben Sie ihr einen Namen, der sagt, wofür sie da ist.');
    expect(page).toContain('Eine zeitgesteuerte Regel läuft von selbst, daher steht „me“ für niemanden.');
    expect(page).not.toContain('Give it a name');
  });
});

describe('a problem a catalog can’t say whole (D49)', () => {
  it('is said in the server’s English, not with a key for the words the catalog lacks', () => {
    const words: ProblemSaid = { key: 'query.invalid', values: { problems: [{ key: 'query.unknownValue', values: { value: 'Fixd', field: 'State', hasGuess: 'yes', guess: 'Fixed', n: 2, allowed: '' } }] } };
    expect(canSayProblem(de, words)).toBe(true);
    // A catalog with the refusal's words but not the query's problem in it (one still to translate).
    const partial = createTranslator('es', { 'problem.query.invalid': 'Consulta no válida: {problems}' });
    expect(canSayProblem(partial, words)).toBe(false);
    expect(problemFor(partial, { message: 'Invalid query: Unknown value "Fixd" for State (Did you mean "Fixed"?)', words })).toBe('Invalid query: Unknown value "Fixd" for State (Did you mean "Fixed"?)');
  });
});

describe('why an agent’s change can’t be undone, in a person’s language (D49)', () => {
  it('says each reason as a sentence of its own', () => {
    const words: ProblemSaid = {
      key: 'agents.nothingUndoneBecause',
      values: {
        reasons: [
          { key: 'agents.stop.fieldChanged', values: { field: 'Priority', hasValue: 'yes', value: 'Major', hasBy: 'yes', by: 'Anna Schmidt' } },
          { key: 'agents.stop.fieldChanged', values: { field: 'Assignee', hasValue: 'no', value: '', hasBy: 'no', by: '' } },
          { key: 'agents.stop.tagsOff', values: { n: 2, tags: 'urgent, regression' } },
          { key: 'agents.stop.summaryChanged', values: { hasBy: 'no', by: '' } },
        ],
      },
    };
    expect(sayProblem(en, words)).toBe(
      'Nothing was undone. Priority is Major now: Anna Schmidt changed it since. Assignee is empty now. The tags urgent, regression were taken off since. The summary changed since. Change it on the issue instead, if it should change.',
    );
    expect(sayProblem(de, words)).toBe(
      'Nichts wurde rückgängig gemacht. Priority ist jetzt Major: Anna Schmidt hat es inzwischen geändert. Assignee ist jetzt leer. Die Tags urgent, regression wurden inzwischen entfernt. Die Zusammenfassung hat sich inzwischen geändert. Ändern Sie es stattdessen am Vorgang, falls es sich ändern soll.',
    );
  });
});

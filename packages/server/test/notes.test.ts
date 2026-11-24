/**
 * What a rule's preview and a script's test run say on a page, in its person's language (D49). The
 * server sends what its note says as data (`says`) and each issue's errors with their words, and a
 * page words them (packages/shared/src/notes.ts). The page's English is the API's note, word for
 * word; German says it in German, with no English sentence left in it.
 */
import type { RulePreview, ScriptRun } from '@a4a/shared';
import { canSayProblem, sayProblem, type ProblemSaid } from '@a4a/shared/i18n';
import { notesIn, previewNote, scriptRunNote } from '@a4a/shared/notes';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { commandOutcome } from '../src/chat/service';
import { runCommand } from '../src/commands/executor';
import { rules } from '../src/db/schema';
import { translatorFor } from '../src/i18n';
import { createIssue } from '../src/services/issues';
import { checkRulePart, createRule, previewRule, testRule } from '../src/workflow/rules';
import { createWorld, type TestWorld } from './helpers';

let w: TestWorld;
const en = translatorFor('en');
const de = translatorFor('de');

/** English a note says: none of these is a word a German note says, nor in this file's queries and scripts. */
const ENGLISH = /\b(issues?|matches|match|acts?|runs?|Here is|would|rule|Fix|Only|query|nothing|saved|asks?|command|refuse|through|post)\b/;

/** The page's English is the API's; its German is German. */
function previewSays(p: RulePreview): string {
  expect(previewNote(en, p)).toBe(p.note);
  const german = previewNote(de, p);
  expect(german).not.toMatch(ENGLISH);
  return german;
}

function runSays(run: ScriptRun): string {
  expect(scriptRunNote(en, run)).toBe(run.note);
  return scriptRunNote(de, run);
}

/** Each issue's errors, as a German page says them: every one by its words. */
function germanErrors(errors: string[], words: ProblemSaid[] | undefined): string[] {
  expect(words).toHaveLength(errors.length);
  return words!.map((x) => {
    expect(canSayProblem(de, x)).toBe(true);
    return sayProblem(de, x);
  });
}

beforeAll(async () => {
  w = await createWorld();
  await createIssue(w.as(w.anna), { project: 'BACK', summary: 'Notiz eins', fields: { Priority: 'Major' } });
  await createIssue(w.as(w.anna), { project: 'BACK', summary: 'Notiz zwei', fields: { Priority: 'Major' } });
});

afterEach(async () => {
  await w.app.db.delete(rules);
});

afterAll(async () => {
  await w.close();
});

const base = { project: 'BACK', name: 'Notizen', query: 'summary: Notiz' };

describe("a rule's preview", () => {
  it('says what a part to fix stops', async () => {
    const p = await previewRule(w.adminCtx, { ...base, kind: 'change', trigger: 'created', query: 'Stat: Open', command: 'tag x' });
    expect(p.says.shows).toBe('fixUnderlined');
    expect(previewSays(p)).toBe('Korrigieren Sie das Unterstrichene, um die Vorgänge zu sehen, die die Regel betreffen würde.');
  });

  it('says how a rule acts on the issues it matches, and what it shows of them', async () => {
    const p = await previewRule(w.adminCtx, { ...base, kind: 'change', trigger: 'created', command: 'tag noted' });
    expect(p.note).toBe('2 issues match it now. It acts on one only when an issue is created. Here is what it would do to 2 of them, as they are now.');
    expect(previewSays(p)).toBe(
      '2 Vorgänge entsprechen ihr jetzt. Die Regel handelt bei einem Vorgang nur, wenn ein Vorgang angelegt wird. Hier sehen Sie, was die Regel mit 2 davon tun würde, so wie sie jetzt sind.',
    );
    const field = await previewRule(w.adminCtx, { ...base, kind: 'change', trigger: 'updated', field: 'Priority', command: 'tag noted' });
    expect(previewSays(field)).toContain('wenn sich Priority eines Vorgangs ändert');
  });

  it('says a scheduled rule that reaches other issues, and whom it tells', async () => {
    const p = await previewRule(w.adminCtx, {
      ...base,
      kind: 'schedule',
      schedule: { every: 'day', at: '08:30' },
      command: 'tag noted',
      target: { to: 'parent' },
      notify: { to: ['assignee'], people: [], message: 'Look' },
    });
    expect(p.note).toBe('2 issues match it now. Every day at 08:30, it acts for each of them. It acts on its parent.');
    expect(previewSays(p)).toBe('2 Vorgänge entsprechen ihr jetzt. Jeden Tag um 08:30 handelt die Regel für jeden davon. Die Regel wirkt auf den übergeordneten Vorgang.');
    const each = await previewRule(w.adminCtx, { ...base, kind: 'schedule', schedule: { every: 'hour' }, command: 'tag noted', notify: { to: ['assignee'], people: [], message: 'Look' } });
    expect(previewSays(each)).toContain('(wer sie auslöst, wird nie benachrichtigt)');
  });

  it('reads a saved rule acting on each issue itself as acting on it, not on "it" again', async () => {
    // A saved rule's target is "issue" for the issue itself: the card previews it as saved.
    const p = await previewRule(w.adminCtx, { ...base, kind: 'change', trigger: 'created', command: 'tag noted', target: { to: 'issue' } });
    expect(p.note).toBe('2 issues match it now. It acts on one only when an issue is created. Here is what it would do to 2 of them, as they are now.');
    expect(p.says.target).toBeNull();
    expect(p.sample.every((x) => !x.via)).toBe(true);
    previewSays(p);
  });

  it("says a guard's matches, those that break it already, and why, in German", async () => {
    const kept = await previewRule(w.adminCtx, { ...base, kind: 'guard', requires: 'Priority: Major', message: 'Hoch.' });
    expect(previewSays(kept)).toBe('2 Vorgänge entsprechen jetzt „summary: Notiz“, und alle halten die Regel ein. Ab jetzt lehnt die Regel jede Änderung ab, durch die ein Vorgang sie verletzen würde.');
    const breaking = await previewRule(w.adminCtx, { ...base, kind: 'guard', requires: 'Priority: Critical', message: 'Hoch.' });
    expect(breaking.breaking).toBe(2);
    expect(previewSays(breaking)).toMatch(/^2 Vorgänge entsprechen jetzt „summary: Notiz“, und 2 davon verletzen die Regel/);
    const sample = breaking.sample[0]!;
    expect(sample.errors).toEqual(['Already breaks it: it matches “summary: Notiz” but not “Priority: Critical”']);
    expect(germanErrors(sample.errors, sample.errorWords as ProblemSaid[])).toEqual(['Verletzt die Regel bereits: Er entspricht „summary: Notiz“, aber nicht „Priority: Critical“.']);
  });

  it("says a scripted rule's preview, what stops it, and what its script would do", async () => {
    const scripted = { ...base, kind: 'change' as const, trigger: 'created' as const };
    const runs = await previewRule(w.adminCtx, { ...scripted, script: "apply('tag scripted')" });
    expect(runs.note).toBe('2 issues match its query now. It runs on one when an issue is created. Here is what its script would do to 2 of them, as they are now (a dry run: nothing was saved).');
    expect(previewSays(runs)).toBe(
      '2 Vorgänge entsprechen jetzt ihrer Abfrage. Die Regel läuft für einen Vorgang, sobald ein Vorgang angelegt wird. Hier sehen Sie, was ihr Skript mit 2 davon tun würde, so wie sie jetzt sind (ein Probelauf: Nichts wurde gespeichert).',
    );
    const broken = await previewRule(w.adminCtx, { ...scripted, script: 'nope(' });
    expect(broken.says.shows).toBe('fixScript');
    expect(previewSays(broken)).toBe('2 Vorgänge entsprechen jetzt ihrer Abfrage. Korrigieren Sie das Skript, um zu sehen, was die Regel tun würde.');
    const unsaved = await previewRule(w.as(w.anna), { ...scripted, script: "apply('tag scripted')" });
    expect(unsaved.says.shows).toBe('adminOnly');
    expect(previewSays(unsaved)).toBe('2 Vorgänge entsprechen jetzt ihrer Abfrage. Nur Administratoren können ein nicht gespeichertes Skript ausführen.');

    const refusing = await previewRule(w.adminCtx, { ...scripted, script: "refuse('Nicht jetzt')" });
    previewSays(refusing);
    const [said] = refusing.sample[0]!.errors;
    expect(said).toBe('Would do nothing: “Nicht jetzt”');
    expect(germanErrors(refusing.sample[0]!.errors, refusing.sample[0]!.errorWords as ProblemSaid[])).toEqual(['Würde nichts tun: „Nicht jetzt“.']);
    const guard = await previewRule(w.adminCtx, { ...base, kind: 'guard', script: "refuse('Zu früh')" });
    expect(previewSays(guard)).toContain('Die Regel läuft bei jeder Änderung an einem passenden Vorgang und kann sie ablehnen.');
    expect(germanErrors(guard.sample[0]!.errors, guard.sample[0]!.errorWords as ProblemSaid[])).toEqual(['Würde eine Änderung an diesem Vorgang ablehnen: „Zu früh“.']);
  });
});

describe("a script's test run", () => {
  const draft = { ...base, kind: 'change' as const, trigger: 'updated' as const };
  const on = async () => (await createIssue(w.as(w.anna), { project: 'BACK', summary: 'Notiz drei', fields: { Priority: 'Major' } })).id;

  it('says the commands it asks for, and what it would post', async () => {
    const issue = await on();
    const run = await testRule(w.adminCtx, { ...draft, script: "apply('tag t1'); comment('Hallo')", issue });
    expect(run.note).toBe('It asks for 1 command: 1 would change something. It would post a comment. Nothing was saved.');
    expect(runSays(run)).toBe('Es fordert 1 Befehl an: 1 würde etwas ändern. Es würde einen Kommentar schreiben. Nichts wurde gespeichert.');
    const quiet = await testRule(w.adminCtx, { ...draft, script: "log('x')", issue });
    expect(runSays(quiet)).toBe('Es fordert keinen Befehl an. Nichts wurde gespeichert.');
  });

  it("says a command that would fail in the page's language, by its problem's words", async () => {
    const run = await testRule(w.adminCtx, { ...draft, script: "apply('Priority Gigantisch')", issue: await on() });
    expect(run.says).toMatchObject({ outcome: 'asks', commands: 1, failing: 1 });
    expect(runSays(run)).toBe('Es fordert 1 Befehl an: 0 würden etwas ändern, 1 würde fehlschlagen. Nichts wurde gespeichert.');
    const failed = run.applies[0]!;
    const [german] = germanErrors(failed.errors, failed.errorWords as ProblemSaid[]);
    expect(german).not.toMatch(ENGLISH);
  });

  it("says a guard's refusal, the change it lets through, and what it ignores", async () => {
    const issue = await on();
    const refusing = await testRule(w.adminCtx, { ...base, kind: 'guard', script: "refuse('Zu früh')", issue });
    expect(runSays(refusing)).toBe('Es würde diese Änderung ablehnen: „Zu früh“.');
    const passing = await testRule(w.adminCtx, { ...base, kind: 'guard', script: "apply('tag x')", issue });
    expect(passing.note).toBe('It would let this change through. A guard only refuses: what it applies or comments is ignored.');
    expect(runSays(passing)).toBe('Es würde diese Änderung durchlassen. Ein Wächter lehnt nur ab: Was er anwendet oder kommentiert, wird ignoriert.');
    const nothing = await testRule(w.adminCtx, { ...draft, script: "refuse('Nicht jetzt')", issue });
    expect(runSays(nothing)).toBe('Es würde nichts tun: „Nicht jetzt“.');
  });

  it('says a script that stopped: its engine in its own words, its time limit in German', async () => {
    const issue = await on();
    const thrown = await testRule(w.adminCtx, { ...draft, script: "throw new Error('kaputt')", issue });
    expect(thrown.says.outcome).toBe('stopped');
    expect(runSays(thrown)).toBe(`Das Skript wurde angehalten: ${thrown.error!.message}. Nichts von dem, was es angefordert hat, würde ausgeführt.`);
    const looping = await testRule(w.adminCtx, { ...base, kind: 'guard', script: 'while (true) {}', issue });
    expect(looping.error).toMatchObject({ kind: 'time', key: 'script.ranTooLong' });
    expect(runSays(looping)).toMatch(/^Das Skript wurde angehalten: Das Skript lief länger als \d+ ms und wurde angehalten: eine Schleife ohne Ende oder zu viel Arbeit für einen Vorgang\. Nichts von dem/);
  });
});

describe("the rule form's reading of a part", () => {
  it('reads a query, a command and a script in the page’s language, and in English for an agent', async () => {
    const page = { ...w.adminCtx, pageLocale: 'de' as const };
    const part = (ctx: typeof w.adminCtx, p: 'query' | 'command' | 'script', text: string) => checkRulePart(ctx, { project: 'BACK', kind: 'change', part: p, text });
    expect((await part(w.adminCtx, 'command', 'Priority Major tag perf')).description).toBe('set Priority to Major; add tag perf');
    expect((await part(page, 'command', 'Priority Major tag perf')).description).toBe('Priority auf Major setzen; Tag perf hinzufügen');
    expect((await part(page, 'command', '')).description).toBe('Keine Änderungen');
    expect((await part(w.adminCtx, 'query', '#Unresolved')).description).toMatch(/^Issues /);
    expect((await part(page, 'query', '#Unresolved')).description).toMatch(/^Vorgänge/);
    expect((await part(w.adminCtx, 'script', "apply('tag x')")).description).toBe('It compiles.');
    expect((await part(page, 'script', "apply('tag x')")).description).toBe('Das Skript lässt sich kompilieren.');
    // A script's problem keeps its words on the way, so the page says it in German.
    const empty = await part(page, 'script', '');
    expect(empty.problems[0]).toMatchObject({ key: 'rule.writeScript' });
  });
});

describe("the chat bot's reply to a command", () => {
  it("says a command's problems, its errors on the issue and its change in the person's language", async () => {
    const issue = (await createIssue(w.as(w.anna), { project: 'BACK', summary: 'Chat eins', fields: { Priority: 'Major' } })).id;
    const anna = w.as(w.anna);
    // As it's written: the parser's problem, in German, and as the API says it in English.
    expect(commandOutcome(await runCommand(anna, { issues: [issue], command: 'State Fixd' }, de), de)).toEqual({ text: 'Unbekannter Wert „Fixd“ für State. Meinten Sie „Fixed“?', bad: true });
    expect(commandOutcome(await runCommand(anna, { issues: [issue], command: 'State Fixd' }, en), en).text).toBe('Unknown value "Fixd" for State. Did you mean "Fixed"?');
    // What it changed: the command's words stay as written, what a4a says of them is German.
    expect(commandOutcome(await runCommand(anna, { issues: [issue], command: 'tag plaudern' }, de), de)).toEqual({ text: 'Ausgeführt: Tag plaudern hinzufügen.', bad: false });
    // Why it failed on the issue: a guard's refusal, by its words.
    await createRule(w.adminCtx, { ...base, name: 'Hoch', kind: 'guard', query: 'summary: Chat', requires: 'Priority: Major', message: 'Bleibt hoch.' });
    const refused = commandOutcome(await runCommand(anna, { issues: [issue], command: 'Priority Minor' }, de), de);
    expect(refused.bad).toBe(true);
    expect(refused.text).toContain('Bleibt hoch.');
    expect(refused.text).not.toMatch(/refuses|rule/);
  });
});

describe("a command's errors on each issue", () => {
  it('carry their words, so a page says them in its language', async () => {
    // UI is a Subsystem of WEB's, not BACK's: the command reads for both, and fails on BACK's issue.
    const back = (await createIssue(w.as(w.anna), { project: 'BACK', summary: 'Teil eins' })).id;
    const web = (await createIssue(w.as(w.anna), { project: 'WEB', summary: 'Teil zwei' })).id;
    const res = await runCommand(w.adminCtx, { issues: [back, web], command: 'Subsystem UI', dryRun: true });
    const failed = res.results.find((r) => r.issue === back)!;
    expect(failed.errors).toHaveLength(1);
    const [german] = germanErrors(failed.errors, failed.errorWords as ProblemSaid[]);
    expect(german).not.toBe(failed.errors[0]);
    expect(german).not.toMatch(ENGLISH);
    expect(res.results.find((r) => r.issue === web)).toMatchObject({ errors: [], errorWords: [] });
  });
});

describe("a rule run's kept notes", () => {
  it('says whom it told as the language\'s list, with how many more as its last item', () => {
    const said = [{ key: 'rules.run.told', values: { names: ['Anna Schmidt', 'Ben Okafor', { key: 'rules.run.toldOthers', values: { more: 3 } }] } }];
    const english = 'Told Anna Schmidt, Ben Okafor and 3 others';
    expect(notesIn(translatorFor('en'), said, english)).toBe('Told Anna Schmidt, Ben Okafor and 3 others.');
    expect(notesIn(translatorFor('de'), said, english)).toBe('Benachrichtigt: Anna Schmidt, Ben Okafor und 3 weitere.');
    expect(notesIn(translatorFor('ja'), said, english)).toBe('Anna Schmidt、Ben Okafor、ほか3人に通知しました。');
    expect(notesIn(translatorFor('zh'), said, english)).toBe('通知了 Anna Schmidt、Ben Okafor和另外 3 人。');
    expect(notesIn(translatorFor('ko'), said, english)).toBe('Anna Schmidt, Ben Okafor 및 다른 3명에게 알렸습니다.');
    expect(notesIn(translatorFor('pt'), said, english)).toBe('Avisou Anna Schmidt, Ben Okafor e mais 3 pessoas.');
    // Thai's list glues และ to the next item; beside a name, which Thai sets off, it takes a space, and a bare space a comma.
    expect(notesIn(translatorFor('th'), said, english)).toBe('แจ้ง Anna Schmidt, Ben Okafor และอีก 3 คน แล้ว');
    // Three names are a list of three: "and" before the last, in each language's way.
    const three = [{ key: 'rules.run.told', values: { names: ['Anna', 'Ben', 'Carl'] } }];
    expect(notesIn(translatorFor('en'), three, '')).toBe('Told Anna, Ben and Carl.');
    expect(notesIn(translatorFor('fr'), three, '')).toBe('Elle a prévenu Anna, Ben et Carl.');
    expect(notesIn(translatorFor('pt'), three, '')).toBe('Avisou Anna, Ben e Carl.');
    expect(notesIn(translatorFor('th'), three, '')).toBe('แจ้ง Anna, Ben และ Carl แล้ว');
  });

  it("says what it changed as the language's list, each field's change with the language's own colon", () => {
    const said = [
      { key: 'rules.run.changed', values: { changes: [{ key: 'rules.run.fieldChange', values: { field: 'State', from: 'Open', to: 'Fixed' } }, { key: 'rules.run.fieldChange', values: { field: 'Priority', from: '—', to: 'High' } }] } },
      {
        key: 'rules.run.alsoChanged',
        values: {
          others: [
            { key: 'rules.run.otherChanged', values: { issue: 'BACK-12', changes: [{ key: 'rules.run.fieldTo', values: { field: 'State', to: 'Fixed' } }, { key: 'rules.run.fieldTo', values: { field: 'Priority', to: 'High' } }] } },
            { key: 'rules.run.otherChanged', values: { issue: 'BACK-13', changes: [{ key: 'rules.run.fieldTo', values: { field: 'State', to: 'Fixed' } }] } },
          ],
        },
      },
    ];
    const english = 'State: Open → Fixed; Priority: — → High; Also changed BACK-12: State → Fixed, Priority → High; BACK-13: State → Fixed';
    expect(notesIn(translatorFor('en'), said, english)).toBe('State: Open → Fixed and Priority: — → High. Also changed BACK-12 (State → Fixed and Priority → High) and BACK-13 (State → Fixed).');
    expect(notesIn(translatorFor('de'), said, english)).toBe('State: Open → Fixed und Priority: — → High. Außerdem geändert: BACK-12 (State → Fixed und Priority → High) und BACK-13 (State → Fixed).');
    expect(notesIn(translatorFor('fr'), said, english)).toBe('State\u00a0: Open → Fixed et Priority\u00a0: — → High. Elle a aussi modifié BACK-12 (State → Fixed et Priority → High) et BACK-13 (State → Fixed).');
    expect(notesIn(translatorFor('ja'), said, english)).toBe('State：Open → Fixed、Priority：— → High。ほかにBACK-12（State → Fixed、Priority → High）、BACK-13（State → Fixed）を変更しました。');
    expect(notesIn(translatorFor('zh'), said, english)).toBe('State：Open → Fixed和Priority：— → High。还更改了 BACK-12（State → Fixed和Priority → High）和BACK-13（State → Fixed）。');
    // A run kept before its changes were a list keeps the English it joined them with.
    expect(notesIn(translatorFor('de'), [{ key: 'rules.run.alsoChanged', values: { others: 'BACK-12: State → Fixed' } }], '')).toBe('Außerdem geändert: BACK-12: State → Fixed.');
  });
});

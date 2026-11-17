/**
 * What a rule's preview and a script's test run say on a page, in its person's language (D49). The
 * server sends what its note says as data (`says`) and each issue's errors with their words, and a
 * page words them (packages/shared/src/notes.ts). The page's English is the API's note, word for
 * word; German says it in German, with no English sentence left in it.
 */
import type { RulePreview, ScriptRun } from '@a4a/shared';
import { canSayProblem, sayProblem, type ProblemSaid } from '@a4a/shared/i18n';
import { previewNote, scriptRunNote } from '@a4a/shared/notes';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { runCommand } from '../src/commands/executor';
import { rules } from '../src/db/schema';
import { translatorFor } from '../src/i18n';
import { createIssue } from '../src/services/issues';
import { createRule, previewRule, testRule } from '../src/workflow/rules';
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
    expect(previewSays(each)).toContain('(wer sie auslöst, wird nie informiert)');
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
    expect(previewSays(broken)).toBe('2 Vorgänge entsprechen jetzt ihrer Abfrage. Korrigieren Sie ihr Skript, um zu sehen, was die Regel tun würde.');
    const unsaved = await previewRule(w.as(w.anna), { ...scripted, script: "apply('tag scripted')" });
    expect(unsaved.says.shows).toBe('adminOnly');
    expect(previewSays(unsaved)).toBe('2 Vorgänge entsprechen jetzt ihrer Abfrage. Nur Administratoren führen ein Skript aus, das nicht gespeichert ist.');

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

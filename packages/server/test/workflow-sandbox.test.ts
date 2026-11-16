/** The sandbox scripted workflows run in (D40): what a script reaches, what it asks, and how it's stopped. */
import { describe, expect, it } from 'vitest';
import { checkScript, runScript, SCRIPT_LIMITS } from '../src/workflow/sandbox';

const input = {
  issue: { id: 'BACK-1', summary: 'Checkout fails', fields: { State: 'Open', Priority: 'Critical' }, tags: ['urgent'], parent: null, subtasks: [] },
  change: { kind: 'updated', by: { login: 'anna', name: 'Anna', agent: false }, changes: [{ field: 'Priority', from: 'Major', to: 'Critical' }] },
  project: { key: 'BACK', name: 'Backend' },
};

describe('the sandbox', () => {
  it('runs a script on the issue it is given, and writes down what it asks', async () => {
    const out = await runScript(
      `if (issue.fields.Priority === 'Critical' && !issue.tags.includes('triaged')) {
        apply('tag triaged');
        comment('Critical: tagged for the next stand-up.');
        log('changed by', change.by.login, change.changes);
      }`,
      input,
    );
    expect(out.error).toBeNull();
    expect(out.intents.applies).toEqual([{ command: 'tag triaged', to: null }]);
    expect(out.intents.comments).toEqual(['Critical: tagged for the next stand-up.']);
    expect(out.intents.logs).toEqual(['changed by anna [{"field":"Priority","from":"Major","to":"Critical"}]']);
  });

  it('reaches nothing outside: no network, timers, modules or process', async () => {
    const out = await runScript(`log(typeof fetch, typeof setTimeout, typeof require, typeof process, typeof XMLHttpRequest, typeof globalThis.__input)`, input);
    expect(out.intents.logs).toEqual(['undefined undefined undefined undefined undefined undefined']);
  });

  it("can't change what it was given", async () => {
    const out = await runScript(`"use strict"; issue.fields.State = 'Fixed';`, input);
    expect(out.error).toMatchObject({ kind: 'runtime' });
    expect(out.error!.message).toMatch(/TypeError/);
  });

  it('stops a script that runs too long, or takes too much memory', async () => {
    const loop = await runScript('while (true) {}', input, { timeMs: 40 });
    expect(loop.error).toMatchObject({ kind: 'time' });
    expect(loop.ms).toBeLessThan(1000);
    const hog = await runScript('const xs = []; for (let i = 0; ; i++) xs.push("x".repeat(1000000) + i);', input, { timeMs: 5000 });
    expect(hog.error).toMatchObject({ kind: 'memory' });
  });

  it('says where a script went wrong, and what a function was given wrongly', async () => {
    const out = await runScript('const a = 1;\nnothing();\n', input);
    expect(out.error).toMatchObject({ kind: 'runtime', line: 2 });
    expect(out.error!.message).toMatch(/'nothing' is not defined \(line 2\)/);
    const bad = await runScript('apply(42)', input);
    expect(bad.error!.message).toMatch(/apply\(\) takes a command/);
  });

  it('keeps a run to its limits', async () => {
    const out = await runScript(`for (let i = 0; i < ${SCRIPT_LIMITS.applies + 5}; i++) apply('tag t' + i)`, input);
    expect(out.error!.message).toMatch(new RegExp(`${SCRIPT_LIMITS.applies} commands at most`));
    expect(out.intents.applies).toHaveLength(SCRIPT_LIMITS.applies);
  });

  it('refuses in its own words, and names an issue to change by its id', async () => {
    const out = await runScript(`refuse('Say why in a comment first.'); apply('State Fixed', 'back-7')`, input);
    expect(out.intents.refusal).toBe('Say why in a comment first.');
    expect(out.intents.applies).toEqual([{ command: 'State Fixed', to: 'BACK-7' }]);
  });

  it('checks syntax without running anything, at the line it is on', async () => {
    expect(await checkScript("apply('tag ok')")).toEqual([]);
    const source = "const a = 1;\nconst b = ;\napply('x')";
    const [p] = await checkScript(source);
    expect(p).toMatchObject({ line: 2 });
    expect(source.slice(p!.start, p!.end)).toBe('const b = ;');
    expect(await checkScript('   ')).toMatchObject([{ message: 'Write what it does, in JavaScript' }]);
    // Compiling runs nothing: a loop that never ends is only checked.
    expect(await checkScript('while (true) {}')).toEqual([]);
  });
});

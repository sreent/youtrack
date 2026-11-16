/**
 * The sandbox scripted workflows run in (docs/architecture.md, D40): QuickJS, compiled to
 * WebAssembly, a new runtime for every run.
 *
 * A script reaches nothing but what a4a hands it: no network, no files, no timers, no modules, no
 * host objects. It gets the issue (and what changed) as frozen data, and four functions that only
 * write down what it wants: apply(command[, issue]), comment(text), refuse(message), log(...). a4a
 * does what it asked once the script has finished, through the command executor, so a script's
 * changes go the way every change goes (D4). It can't wait on anything, so a run is a pure function
 * of what it was given: bounded in time (the interrupt handler) and memory (QuickJS's allocator).
 */
import { getQuickJS, shouldInterruptAfterDeadline, type QuickJSContext, type QuickJSHandle, type QuickJSWASMModule } from 'quickjs-emscripten';

export const SCRIPT_LIMITS = {
  /** Longest a script may be, in characters. */
  source: 20_000,
  /** A run on a change, a schedule or an action. */
  timeMs: 250,
  /** A guard runs inside the write path, before commit: it must be quick. */
  guardTimeMs: 60,
  memoryBytes: 16 * 1024 * 1024,
  stackBytes: 512 * 1024,
  applies: 20,
  comments: 5,
  logs: 50,
  text: 2000,
} as const;

export interface ScriptIntents {
  /** Commands to apply, in the command language: to the issue (`to` null) or to one related to it. */
  applies: { command: string; to: string | null }[];
  comments: string[];
  /** A guard's refusal, in its words; or an action's or rule's "don't". */
  refusal: string | null;
  logs: string[];
}

export type ScriptErrorKind = 'syntax' | 'runtime' | 'time' | 'memory';

export interface ScriptError {
  kind: ScriptErrorKind;
  message: string;
  /** The script's line it stopped at, from 1, when QuickJS says. */
  line: number | null;
}

export interface ScriptOutcome {
  intents: ScriptIntents;
  error: ScriptError | null;
  ms: number;
}

/** What needs fixing in a script's text before it can run: its syntax, at the line it's on. */
export interface ScriptProblem {
  message: string;
  start: number;
  end: number;
  hint?: string;
  line: number | null;
}

let quickjs: Promise<QuickJSWASMModule> | null = null;
/** QuickJS's WebAssembly module, loaded once per process. */
export function sandboxModule(): Promise<QuickJSWASMModule> {
  return (quickjs ??= getQuickJS());
}

const empty = (): ScriptIntents => ({ applies: [], comments: [], refusal: null, logs: [] });

function clip(text: string): string {
  return text.length > SCRIPT_LIMITS.text ? `${text.slice(0, SCRIPT_LIMITS.text - 1)}…` : text;
}

/** One line of a log: strings as they are, everything else as JSON. */
function shown(v: unknown): string {
  if (typeof v === 'string') return v;
  if (v === undefined) return 'undefined';
  try {
    return JSON.stringify(v) ?? String(v);
  } catch {
    return String(v);
  }
}

function lineOf(dumped: { lineNumber?: unknown; stack?: unknown }): number | null {
  if (typeof dumped.lineNumber === 'number') return dumped.lineNumber;
  const m = /script\.js:(\d+)/.exec(typeof dumped.stack === 'string' ? dumped.stack : '');
  return m ? Number(m[1]) : null;
}

function errorOf(vm: QuickJSContext, handle: QuickJSHandle, limitMs: number): ScriptError {
  const d = vm.dump(handle) as { name?: string; message?: string; stack?: string; lineNumber?: number } | string;
  const e = typeof d === 'object' && d ? d : { name: 'Error', message: String(d) };
  const message = e.message ?? String(e);
  const line = lineOf(e);
  if (e.name === 'InternalError' && /interrupted/.test(message)) {
    return { kind: 'time', message: `It ran past ${limitMs} ms and was stopped: a loop that doesn't end, or too much work for one issue`, line: null };
  }
  if (e.name === 'InternalError' && /out of memory/.test(message)) {
    return { kind: 'memory', message: `It used more than ${SCRIPT_LIMITS.memoryBytes / 1024 / 1024} MB and was stopped`, line };
  }
  if (e.name === 'SyntaxError') return { kind: 'syntax', message: `${message}${line ? ` (line ${line})` : ''}`, line };
  return { kind: 'runtime', message: `${e.name ?? 'Error'}: ${message}${line ? ` (line ${line})` : ''}`, line };
}

/** The script's line `line` (from 1) as a range of its text, for underlining. */
function lineRange(source: string, line: number | null): { start: number; end: number } {
  if (!line || line < 1) return { start: 0, end: source.length };
  let start = 0;
  for (let i = 1; i < line; i++) {
    const next = source.indexOf('\n', start);
    if (next < 0) return { start: source.length, end: source.length };
    start = next + 1;
  }
  const end = source.indexOf('\n', start);
  return { start, end: end < 0 ? source.length : end };
}

function newVm(module: QuickJSWASMModule) {
  const runtime = module.newRuntime();
  runtime.setMemoryLimit(SCRIPT_LIMITS.memoryBytes);
  runtime.setMaxStackSize(SCRIPT_LIMITS.stackBytes);
  const vm = runtime.newContext();
  return { runtime, vm };
}

/** What stops a script from compiling, at the line it's on; empty when it compiles. Nothing in it runs. */
export async function checkScript(source: string): Promise<ScriptProblem[]> {
  if (!source.trim()) return [{ message: 'Write what it does, in JavaScript', start: 0, end: 0, line: null, hint: "e.g. if (!issue.fields.Assignee) apply('for me')" }];
  if (source.length > SCRIPT_LIMITS.source) {
    return [{ message: `A script can be ${SCRIPT_LIMITS.source.toLocaleString('en')} characters at most`, start: SCRIPT_LIMITS.source, end: source.length, line: null }];
  }
  const { runtime, vm } = newVm(await sandboxModule());
  try {
    const res = vm.evalCode(source, 'script.js', { compileOnly: true });
    if (!res.error) {
      res.value.dispose();
      return [];
    }
    const e = errorOf(vm, res.error, SCRIPT_LIMITS.timeMs);
    res.error.dispose();
    return [{ message: e.message, ...lineRange(source, e.line), line: e.line }];
  } finally {
    vm.dispose();
    runtime.dispose();
  }
}

/**
 * Run a script on `input` (its globals: issue, change, project), within `timeMs`. It never throws for
 * what the script does: what went wrong is in `error`, and what it asked before that is in
 * `intents`, which the caller ignores when there is an error.
 */
export async function runScript(source: string, input: { issue: unknown; change: unknown; project: unknown }, opts: { timeMs?: number } = {}): Promise<ScriptOutcome> {
  const limitMs = opts.timeMs ?? SCRIPT_LIMITS.timeMs;
  const intents = empty();
  const started = Date.now();
  const { runtime, vm } = newVm(await sandboxModule());
  const fail = (message: string): never => {
    throw new Error(message);
  };
  try {
    const define = (name: string, fn: (...args: QuickJSHandle[]) => void) => {
      const h = vm.newFunction(name, (...args) => {
        fn(...args);
        return vm.undefined;
      });
      vm.setProp(vm.global, name, h);
      h.dispose();
    };
    define('apply', (command, to) => {
      const text = command ? vm.dump(command) : undefined;
      if (typeof text !== 'string' || !text.trim()) fail("apply() takes a command, in the command language: apply('State Fixed')");
      const target = to === undefined ? undefined : vm.dump(to);
      if (target !== undefined && target !== null && typeof target !== 'string') fail("apply()'s second part is an issue's id, e.g. issue.parent.id");
      if (intents.applies.length >= SCRIPT_LIMITS.applies) fail(`A run applies ${SCRIPT_LIMITS.applies} commands at most`);
      intents.applies.push({ command: clip((text as string).trim()), to: typeof target === 'string' && target.trim() ? target.trim().toUpperCase() : null });
    });
    define('comment', (text) => {
      const t = text ? vm.dump(text) : undefined;
      if (typeof t !== 'string' || !t.trim()) fail('comment() takes the words to post');
      if (intents.comments.length >= SCRIPT_LIMITS.comments) fail(`A run posts ${SCRIPT_LIMITS.comments} comments at most`);
      intents.comments.push(clip((t as string).trim()));
    });
    define('refuse', (message) => {
      const t = message ? vm.dump(message) : undefined;
      intents.refusal = clip(typeof t === 'string' && t.trim() ? t.trim() : 'A workflow script refuses this change');
    });
    define('log', (...args) => {
      if (intents.logs.length >= SCRIPT_LIMITS.logs) return;
      intents.logs.push(clip(args.map((a) => shown(vm.dump(a))).join(' ')));
    });
    // The input, as frozen data: parsed inside the sandbox from text, so no host object crosses over.
    const json = vm.newString(JSON.stringify(input));
    vm.setProp(vm.global, '__input', json);
    json.dispose();
    const prelude = vm.evalCode(
      `(() => {
        const i = JSON.parse(globalThis.__input);
        delete globalThis.__input;
        const freeze = (o) => { if (o && typeof o === 'object') { for (const k of Object.keys(o)) freeze(o[k]); Object.freeze(o); } return o; };
        globalThis.issue = freeze(i.issue);
        globalThis.change = freeze(i.change);
        globalThis.project = freeze(i.project);
      })()`,
      'prelude.js',
    );
    if (prelude.error) {
      const e = errorOf(vm, prelude.error, limitMs);
      prelude.error.dispose();
      return { intents: empty(), error: e, ms: Date.now() - started };
    }
    prelude.value.dispose();
    runtime.setInterruptHandler(shouldInterruptAfterDeadline(Date.now() + limitMs));
    const res = vm.evalCode(source, 'script.js');
    if (res.error) {
      const e = errorOf(vm, res.error, limitMs);
      res.error.dispose();
      return { intents, error: e, ms: Date.now() - started };
    }
    res.value.dispose();
    return { intents, error: null, ms: Date.now() - started };
  } finally {
    vm.dispose();
    runtime.dispose();
  }
}

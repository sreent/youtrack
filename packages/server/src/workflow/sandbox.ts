/**
 * The sandbox scripted workflows run in (docs/architecture.md, D40): QuickJS, compiled to
 * WebAssembly, in a small pool of worker threads, a new runtime for every run.
 *
 * A script reaches nothing but what a4a hands it: no network, no files, no timers, no modules, no
 * host objects. It gets the issue (and what changed) as frozen data, and four functions that only
 * write down what it wants: apply(command[, issue]), comment(text), refuse(message), log(...). a4a
 * does what it asked once the script has finished, through the command executor, so a script's
 * changes go the way every change goes (D4).
 *
 * Its limits are hard. Each run goes to a worker thread (./sandbox-worker.mjs), which loaded
 * QuickJS once when it started; the main thread awaits the answer with a timer, and at the run's
 * limit (and HARD_GRACE_MS for the handover to the thread) terminates the worker, starts another in its place, and the run fails saying why. So a
 * script that never yields (a built-in that allocates megabytes at once can run for seconds before
 * QuickJS looks at its own interrupt) holds nothing past its limit: a guard's transaction, a
 * request, the event loop. Memory is QuickJS's allocator's limit, inside the worker.
 */
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import { checkProblemWords, keyedProblem } from '../lib/errors';

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
  /** An app handler's answer (D48), as JSON characters. */
  response: 256 * 1024,
  /** Keys an app handler stores in one run, and the most one value may take, as JSON characters. */
  stores: 50,
  stored: 64 * 1024,
} as const;

/** Worker threads in the pool: each runs one script at a time. */
export const SANDBOX_WORKERS = 2;
/** Reading a script (compiling it, running nothing) gets this long. */
const CHECK_MS = 2000;
/**
 * How long past its limit a run's worker is ended. QuickJS stops ordinary code at the limit itself,
 * counted from when the worker starts the run; this covers only the handover to the worker thread,
 * which a loaded machine can delay, so a run that kept to its limit is never ended for it.
 */
export const HARD_GRACE_MS = 50;

export interface ScriptIntents {
  /** Commands to apply, in the command language: to the issue (`to` null) or to one related to it. */
  applies: { command: string; to: string | null }[];
  comments: string[];
  /** A guard's refusal, in its words; or an action's or rule's "don't". */
  refusal: string | null;
  logs: string[];
  /** An app handler's answer (D48), from respond(). */
  response?: unknown;
  /** What an app handler keeps, from store(key, value); a null value forgets the key. */
  stores?: { key: string; value: unknown }[];
}

export type ScriptErrorKind = 'syntax' | 'runtime' | 'time' | 'memory';

export interface ScriptError {
  kind: ScriptErrorKind;
  message: string;
  /** The script's line it stopped at, from 1, when QuickJS says. */
  line: number | null;
  /** Past its time or memory, its words for a page in another language (D49); none for what QuickJS says. */
  key?: string;
  values?: Record<string, string | number>;
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
  /** Its words for a page in another language (D49); none for what the JavaScript engine itself says. */
  key?: string;
  values?: Record<string, string | number>;
}

const empty = (): ScriptIntents => ({ applies: [], comments: [], refusal: null, logs: [] });

/** Its words, the same in the worker (sandbox-worker.mjs), where time and memory run out. */
const tooLong = (limitMs: number): ScriptError => ({
  kind: 'time',
  message: `It ran past ${limitMs} ms and was stopped: a loop that doesn't end, or too much work for one issue`,
  line: null,
  key: 'script.ranTooLong',
  values: { ms: String(limitMs) },
});

/** A keyed error's English in the catalog says what the API says, under tests, as a problem's must (D49). */
function checked(error: ScriptError | null): ScriptError | null {
  if (error?.key) checkProblemWords(error.message, undefined, error.values ? { key: error.key, values: error.values } : { key: error.key });
  return error;
}

// ---------------------------------------------------------------------------
// The pool
// ---------------------------------------------------------------------------

interface Job {
  id: number;
  kind: 'run' | 'check';
  source: string;
  input?: string;
  timeMs: number;
  /** A guard's run, which waits inside a transaction: it goes ahead of other runs. */
  first: boolean;
  done: (reply: { ok: true; result: unknown } | { ok: false; error: string; timedOut?: boolean }) => void;
}

interface Slot {
  worker: Worker;
  ready: boolean;
  job: Job | null;
  timer: NodeJS.Timeout | null;
  /** Set when we end it, so its exit is expected. */
  ending: boolean;
}

function workerUrl(): URL {
  // From the source (tests, development) it sits beside this file; bundled, tsup writes it beside dist/index.js.
  for (const name of ['./sandbox-worker.mjs', './sandbox-worker.js']) {
    const url = new URL(name, import.meta.url);
    if (existsSync(fileURLToPath(url))) return url;
  }
  throw new Error('The workflow sandbox worker is missing: rebuild the server');
}

class SandboxPool {
  private slots: Slot[] = [];
  private queue: Job[] = [];
  private nextId = 1;
  /** Workers ended at a run's limit, or lost: replaced each time. */
  replaced = 0;
  started = 0;

  constructor(private size: number) {}

  /** Start the workers now, so the first run doesn't wait for one to load QuickJS. */
  warm(): void {
    while (this.slots.length < this.size) this.spawn();
  }

  submit(job: Omit<Job, 'id' | 'done'>): Promise<Parameters<Job['done']>[0]> {
    return new Promise((done) => {
      const full: Job = { ...job, id: this.nextId++, done };
      // A guard's run goes after the guards already waiting, ahead of everything else.
      const at = full.first ? this.queue.findIndex((j) => !j.first) : -1;
      if (at < 0) this.queue.push(full);
      else this.queue.splice(at, 0, full);
      this.warm();
      this.pump();
    });
  }

  stats() {
    return { workers: this.slots.length, ready: this.slots.filter((s) => s.ready).length, busy: this.slots.filter((s) => s.job).length, started: this.started, replaced: this.replaced };
  }

  private spawn(): Slot {
    const worker = new Worker(workerUrl(), { workerData: { limits: SCRIPT_LIMITS } });
    // A worker keeps the process alive while it starts or runs a script, never while it waits for one.
    const slot: Slot = { worker, ready: false, job: null, timer: null, ending: false };
    this.slots.push(slot);
    this.started++;
    worker.on('message', (m: { ready?: true; id?: number; ok?: boolean; result?: unknown; error?: string }) => {
      if (m.ready) {
        slot.ready = true;
        worker.unref();
        this.pump();
        return;
      }
      const job = slot.job;
      if (!job || m.id !== job.id) return;
      this.release(slot);
      job.done(m.ok ? { ok: true, result: m.result } : { ok: false, error: m.error ?? 'The sandbox failed' });
      this.pump();
    });
    const lost = (why: string) => {
      if (slot.ending) return;
      this.end(slot, { ok: false, error: `The sandbox stopped: ${why}` });
    };
    worker.on('error', (e) => lost(e.message));
    worker.on('exit', (code) => lost(`its thread exited (${code})`));
    return slot;
  }

  /** Give the next waiting job to each ready, idle worker, with its timer. */
  private pump(): void {
    for (const slot of this.slots) {
      if (!this.queue.length) return;
      if (!slot.ready || slot.job) continue;
      const job = this.queue.shift()!;
      slot.job = job;
      slot.worker.ref();
      // QuickJS's own interrupt stops ordinary code at the limit, so such a run says what it logged
      // and its worker carries on; the timer ends anything that doesn't stop (HARD_GRACE_MS later).
      slot.timer = setTimeout(() => this.end(slot, { ok: false, error: 'time', timedOut: true }), job.timeMs + HARD_GRACE_MS);
      slot.worker.postMessage({ id: job.id, kind: job.kind, source: job.source, input: job.input, timeMs: job.timeMs });
    }
  }

  private release(slot: Slot): void {
    if (slot.timer) clearTimeout(slot.timer);
    slot.timer = null;
    slot.job = null;
    slot.worker.unref();
  }

  /** End a worker (at a run's limit, or lost), answer its run, and start another in its place. */
  private end(slot: Slot, reply: Parameters<Job['done']>[0]): void {
    const job = slot.job;
    const started = slot.ready;
    this.release(slot);
    slot.ending = true;
    slot.ready = false;
    this.slots = this.slots.filter((s) => s !== slot);
    void slot.worker.terminate().catch(() => {});
    this.replaced++;
    job?.done(reply);
    if (!started) {
      // It died starting (QuickJS missing, say): answer what waits, and start again only when asked,
      // rather than in a loop.
      if (!this.slots.some((s) => s.ready)) for (const waiting of this.queue.splice(0)) waiting.done(reply);
      return;
    }
    this.warm();
    this.pump();
  }
}

const pool = new SandboxPool(SANDBOX_WORKERS);

/** Start the sandbox's workers ahead of the first run (the schema snapshot does, when there are scripts). */
export function warmSandbox(): void {
  pool.warm();
}

/** How the pool stands: for tests, and for saying what a run costs. */
export function sandboxStats() {
  return pool.stats();
}

// ---------------------------------------------------------------------------
// What callers use
// ---------------------------------------------------------------------------

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

/** What stops a script from compiling, at the line it's on; empty when it compiles. Nothing in it runs. */
export async function checkScript(source: string): Promise<ScriptProblem[]> {
  if (!source.trim()) return [keyedProblem({ message: 'Write what it does, in JavaScript', start: 0, end: 0, line: null, hint: "e.g. if (!issue.fields.Assignee) apply('for me')" }, 'rule.writeScript')];
  if (source.length > SCRIPT_LIMITS.source) {
    return [keyedProblem({ message: `A script can be ${SCRIPT_LIMITS.source.toLocaleString('en')} characters at most`, start: SCRIPT_LIMITS.source, end: source.length, line: null }, 'rule.scriptTooLong', { max: SCRIPT_LIMITS.source })];
  }
  const reply = await pool.submit({ kind: 'check', source, timeMs: CHECK_MS, first: false });
  if (!reply.ok) {
    // What the JavaScript engine says of a script it can't read is its own, in English.
    if (!reply.timedOut) return [{ message: reply.error, start: 0, end: source.length, line: null }];
    return [keyedProblem({ message: `It took more than ${CHECK_MS / 1000} s to read`, start: 0, end: source.length, line: null }, 'rule.scriptCheckTimedOut', { seconds: CHECK_MS / 1000 })];
  }
  const e = reply.result as ScriptError | null;
  return e ? [{ message: e.message, ...lineRange(source, e.line), line: e.line }] : [];
}

/**
 * Run a script on `input` (its globals: issue, change, project), within `timeMs` (a guard's, with
 * `guard`, which also puts it ahead of other runs). It never throws for what the script does: what
 * went wrong is in `error`, and what it asked before that is in `intents`, which the caller ignores
 * when there is an error.
 */
export async function runScript(
  source: string,
  input: { issue: unknown; change: unknown; project: unknown; request?: unknown; settings?: unknown; storage?: unknown; app?: unknown },
  opts: { timeMs?: number; guard?: boolean } = {},
): Promise<ScriptOutcome> {
  const limitMs = opts.timeMs ?? (opts.guard ? SCRIPT_LIMITS.guardTimeMs : SCRIPT_LIMITS.timeMs);
  const started = Date.now();
  const reply = await pool.submit({ kind: 'run', source, input: JSON.stringify(input), timeMs: limitMs, first: Boolean(opts.guard) });
  if (reply.ok) {
    const out = reply.result as ScriptOutcome;
    return { ...out, error: checked(out.error) };
  }
  if (reply.timedOut) return { intents: empty(), error: checked(tooLong(limitMs)), ms: Date.now() - started };
  return { intents: empty(), error: { kind: 'runtime', message: reply.error, line: null }, ms: Date.now() - started };
}

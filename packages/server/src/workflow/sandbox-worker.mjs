/**
 * A worker thread of the workflow sandbox (docs/architecture.md, D40). It loads QuickJS's
 * WebAssembly once, then runs one script at a time, each in a new runtime, and says what it asked
 * for. The main thread (./sandbox.ts) times each run and terminates this thread at the run's limit,
 * so a script that never yields (a built-in that allocates megabytes at once) can't hold anything
 * longer than that. QuickJS's own interrupt stops ordinary code at the limit, counted from
 * the run's start here, so a script stopped that way says what it logged, and its worker carries on.
 *
 * Plain JavaScript, so Node runs it as it is, from the source and from the bundle alike.
 */
import { parentPort, workerData } from 'node:worker_threads';
import { getQuickJS, shouldInterruptAfterDeadline } from 'quickjs-emscripten';

/** SCRIPT_LIMITS, from the main thread: one definition of them. */
const L = workerData.limits;

const empty = () => ({ applies: [], comments: [], refusal: null, logs: [], response: undefined, stores: [] });

/** A value as JSON text, or null when it isn't JSON or is longer than `max` characters. */
function jsonOf(v, max) {
  try {
    const text = JSON.stringify(v);
    return text !== undefined && text.length <= max ? text : null;
  } catch {
    return null;
  }
}

function clip(text) {
  return text.length > L.text ? `${text.slice(0, L.text - 1)}…` : text;
}

/** One line of a log: strings as they are, everything else as JSON. */
function shown(v) {
  if (typeof v === 'string') return v;
  if (v === undefined) return 'undefined';
  try {
    return JSON.stringify(v) ?? String(v);
  } catch {
    return String(v);
  }
}

function lineOf(dumped) {
  if (typeof dumped.lineNumber === 'number') return dumped.lineNumber;
  const m = /script\.js:(\d+)/.exec(typeof dumped.stack === 'string' ? dumped.stack : '');
  return m ? Number(m[1]) : null;
}

function errorOf(vm, handle, limitMs) {
  const d = vm.dump(handle);
  const e = typeof d === 'object' && d ? d : { name: 'Error', message: String(d) };
  const message = e.message ?? String(e);
  const line = lineOf(e);
  if (e.name === 'InternalError' && /interrupted/.test(message)) {
    return { kind: 'time', message: `It ran past ${limitMs} ms and was stopped: a loop that doesn't end, or too much work for one issue`, line: null, key: 'script.ranTooLong', values: { ms: String(limitMs) } };
  }
  if (e.name === 'InternalError' && /out of memory/.test(message)) {
    return { kind: 'memory', message: `It used more than ${L.memoryBytes / 1024 / 1024} MB and was stopped`, line, key: 'script.usedTooMuchMemory', values: { mb: String(L.memoryBytes / 1024 / 1024) } };
  }
  if (e.name === 'SyntaxError') return { kind: 'syntax', message: `${message}${line ? ` (line ${line})` : ''}`, line };
  return { kind: 'runtime', message: `${e.name ?? 'Error'}: ${message}${line ? ` (line ${line})` : ''}`, line };
}

function newVm(module) {
  const runtime = module.newRuntime();
  runtime.setMemoryLimit(L.memoryBytes);
  runtime.setMaxStackSize(L.stackBytes);
  return { runtime, vm: runtime.newContext() };
}

/** What stops a script from compiling: its error, or null. Nothing in it runs. */
function check(module, source) {
  const { runtime, vm } = newVm(module);
  try {
    const res = vm.evalCode(source, 'script.js', { compileOnly: true });
    if (!res.error) {
      res.value.dispose();
      return null;
    }
    const e = errorOf(vm, res.error, L.timeMs);
    res.error.dispose();
    return e;
  } finally {
    vm.dispose();
    runtime.dispose();
  }
}

/** Run a script on its input (JSON), stopping it `limitMs` after it starts. */
function run(module, source, inputJson, limitMs) {
  const intents = empty();
  const started = Date.now();
  const { runtime, vm } = newVm(module);
  const fail = (message) => {
    throw new Error(message);
  };
  try {
    const define = (name, fn) => {
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
      if (intents.applies.length >= L.applies) fail(`A run applies ${L.applies} commands at most`);
      intents.applies.push({ command: clip(text.trim()), to: typeof target === 'string' && target.trim() ? target.trim().toUpperCase() : null });
    });
    define('comment', (text) => {
      const t = text ? vm.dump(text) : undefined;
      if (typeof t !== 'string' || !t.trim()) fail('comment() takes the words to post');
      if (intents.comments.length >= L.comments) fail(`A run posts ${L.comments} comments at most`);
      intents.comments.push(clip(t.trim()));
    });
    define('refuse', (message) => {
      const t = message ? vm.dump(message) : undefined;
      intents.refusal = clip(typeof t === 'string' && t.trim() ? t.trim() : 'A workflow script refuses this change');
    });
    // An app's handler (D48) answers with respond(value), and keeps what it wants with store(key, value).
    define('respond', (value) => {
      const v = value === undefined ? null : vm.dump(value);
      const text = jsonOf(v, L.response);
      if (text === null) fail(`respond() takes JSON of ${L.response.toLocaleString('en')} characters at most`);
      intents.response = JSON.parse(text);
    });
    define('store', (key, value) => {
      const k = key ? vm.dump(key) : undefined;
      if (typeof k !== 'string' || !k.trim() || k.length > 200) fail("store() takes a key of 200 characters at most, then its value: store('total', 42)");
      if (intents.stores.length >= L.stores) fail(`A run stores ${L.stores} keys at most`);
      const v = value === undefined ? null : vm.dump(value);
      const text = jsonOf(v, L.stored);
      if (text === null) fail(`A stored value is JSON of ${L.stored.toLocaleString('en')} characters at most`);
      intents.stores.push({ key: k.trim(), value: JSON.parse(text) });
    });
    define('log', (...args) => {
      if (intents.logs.length >= L.logs) return;
      intents.logs.push(clip(args.map((a) => shown(vm.dump(a))).join(' ')));
    });
    // The input, as frozen data: parsed inside the sandbox from text, so no host object crosses over.
    const json = vm.newString(inputJson);
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
        for (const k of ['request', 'settings', 'storage', 'app']) if (k in i) globalThis[k] = freeze(i[k]);
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

const module = await getQuickJS();
parentPort.on('message', (job) => {
  let reply;
  try {
    reply = { id: job.id, ok: true, result: job.kind === 'check' ? check(module, job.source) : run(module, job.source, job.input, job.timeMs) };
  } catch (e) {
    reply = { id: job.id, ok: false, error: e instanceof Error ? e.message : String(e) };
  }
  parentPort.postMessage(reply);
});
parentPort.postMessage({ ready: true });

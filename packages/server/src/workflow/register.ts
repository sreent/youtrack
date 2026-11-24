/** Wires the queued scripts' worker into the server (D40's revisit): the lease holder runs them. */
import { choreFactories } from '../server';
import { runScriptJobs } from './engine';

choreFactories.push((runtime) => [{ name: 'script-queue', everyMs: 15_000, run: () => runScriptJobs(runtime) }]);

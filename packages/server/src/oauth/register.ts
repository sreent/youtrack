/**
 * Wires OAuth for remote MCP's housekeeping into the server (D28): the lease holder prunes codes,
 * tokens, grants and apps for every instance, hourly.
 */
import { choreFactories } from '../server';
import { pruneOAuth } from './grants';

choreFactories.push((runtime) => [{ name: 'oauth-prune', everyMs: 60 * 60_000, run: () => pruneOAuth(runtime.db) }]);

import type { Runtime } from '../app-services';
import type { Ctx } from '../context';

export interface HttpEnv {
  Variables: {
    runtime: Runtime;
    /** Who is acting, or null when nobody is signed in. */
    ctx: Ctx | null;
    requestId: string;
  };
}

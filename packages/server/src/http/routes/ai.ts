import type { OpenAPIHono } from '@hono/zod-openapi';
import type { HttpEnv } from '../env';

/** AI endpoints: filled in by the AI module. */
export function aiRoutes(_app: OpenAPIHono<HttpEnv>): void {}

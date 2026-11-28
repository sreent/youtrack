/**
 * The views of one search (D72), with nothing of zod: what the web reads at run time imports this, as it
 * does `constants`, since the contract's schemas would bring zod into the page, and zod tries `Function`
 * once to see whether it may compile, which the pages' policy reports. `views.ts` re-exports it.
 */
import type { ViewSettings } from './views';

/** The views of one search: its list, and the planning views. Each shows the same issues. */
export const VIEW_KINDS = ['list', 'timeline', 'calendar', 'table', 'workload'] as const;
export type ViewKind = (typeof VIEW_KINDS)[number];

/** What a saved search shows until someone chooses otherwise: its list. */
export const DEFAULT_VIEW: ViewSettings = { kind: 'list', group: null };

/** Whether a word is one of the views' kinds, as an address may say one. */
export function isViewKind(kind: string | null | undefined): kind is ViewKind {
  return Boolean(kind) && (VIEW_KINDS as readonly string[]).includes(kind!);
}

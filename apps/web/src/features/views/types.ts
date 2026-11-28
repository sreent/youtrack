import type { Issue, PlanScope, SavedSearch, ViewSettings } from '@a4a/shared';

/**
 * What every view of a search is given (D72): the list, the timeline, the calendar, the table and the
 * workload. The issues page owns the search, its grouping and what's chosen, so the switch between views
 * keeps all three; each view reads what it shows by the scope, and changes issues the way a command does.
 */
export interface ViewProps {
  /** What it shows: a saved search's issues, or a query's (empty for everything the reader sees), in one project when `project` says so. */
  scope: PlanScope;
  /** The query the scope runs: the saved search's own, or the one typed. */
  query: string;
  /** The saved search it shows, when it shows one: its name, its owner and how it's kept (`view`, `version`). */
  savedSearch: SavedSearch | null;
  /** The field its issues are grouped by, by name; null when they aren't. The same in every view. */
  group: string | null;
  /** How the view is set: the owner's choice kept in the saved search, or what the page's address says. */
  settings: ViewSettings;
  /** Change how it's set. The page keeps it: in the saved search for its owner (with its version), in the address for anyone else. */
  onSettings: (next: ViewSettings) => void;
  /** The issues chosen, by readable id: the same in every view, so they stay chosen across the switch. */
  chosen: Set<string>;
  onChosen: (next: Set<string>) => void;
  /** Run a command on the chosen issues: the page opens its command bar over them. */
  onCommand: () => void;
  /** The issues the page found, a page at a time, in the search's order: what the list shows. The planning views read their own by the scope. */
  issues: Issue[];
}

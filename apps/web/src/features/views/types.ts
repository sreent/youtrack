import type { IssueGroup, IssueListItem, PlanScope, SavedSearch, ViewSettings } from '@a4a/shared';

/** Issues a view names to the command bar: readable ids, and summaries where the view has them. */
export type CommandIssues = { id: string; summary: string }[];

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
  /**
   * The field its issues are grouped by, by name; null when they aren't. The same in every view. It's
   * one the server took: a grouping it refused (a field gone since it was saved) comes as null.
   */
  group: string | null;
  /**
   * How the view is set: the saved search's own, under what its owner just changed and what the page's
   * address says (`view`, `group`), and, for anyone else, what they chose on this page. `kind` is the
   * view asked for, which may be one this build doesn't offer yet (the page then shows the list).
   */
  settings: ViewSettings;
  /**
   * Change how it's set, whole (`settings` with a change): the page keeps it in the saved search for its
   * owner, debounced and with its version, reloading and reapplying when it changed meanwhile; for anyone
   * else the view and grouping go in the page's address, and a view's own settings stay on the page.
   */
  onSettings: (next: ViewSettings) => void;
  /** The issues chosen, by readable id: the same in every view, so they stay chosen across the switch. */
  chosen: Set<string>;
  onChosen: (next: Set<string>) => void;
  /**
   * Run a command on the chosen issues: the page opens its command bar over them. A view whose issues
   * aren't the list's page names them, with their summaries; left out, the bar takes the chosen issues
   * the list's page holds.
   */
  onCommand: (issues?: CommandIssues) => void;
  /**
   * The issues the page found, a page at a time, in the search's order: what the list shows. Grouped,
   * each says its group (`group`, its value; null for the issues with none), and the page's issues come
   * group by group. The planning views read their own by the scope.
   */
  issues: IssueListItem[];
  /** Grouped: every group of the whole result, in order, each with how many it holds, not only on this page. Null when not grouped. */
  groups: IssueGroup[] | null;
}

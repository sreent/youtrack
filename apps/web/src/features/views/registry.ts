import { VIEW_KINDS, type ViewKind } from '@a4a/shared/view-kinds';
import { lazy, type ComponentType, type LazyExoticComponent } from 'react';
import type { ViewProps } from './types';

/** A view of a search, as the view switch offers it (D72). */
export interface ViewEntry {
  kind: ViewKind;
  /** Its name in the switch: a key in the catalogs. */
  label: string;
  /** What draws it, loaded when it's first shown. */
  component: LazyExoticComponent<ComponentType<ViewProps>>;
  /** Whether it's offered yet: a view still being built isn't. */
  available: boolean;
}

/**
 * Every view, by kind. The list is today's; each other view's file is a placeholder that draws nothing
 * until its package brings it, and turns `available` on: the timeline (P2, P5), the calendar (P9), the
 * table (P14) and the workload (P15).
 */
export const VIEWS: Record<ViewKind, ViewEntry> = {
  list: { kind: 'list', label: 'views.kind.list', component: lazy(() => import('./ListView')), available: true },
  timeline: { kind: 'timeline', label: 'views.kind.timeline', component: lazy(() => import('./TimelineView')), available: false },
  calendar: { kind: 'calendar', label: 'views.kind.calendar', component: lazy(() => import('./CalendarView')), available: false },
  table: { kind: 'table', label: 'views.kind.table', component: lazy(() => import('./TableView')), available: false },
  workload: { kind: 'workload', label: 'views.kind.workload', component: lazy(() => import('./WorkloadView')), available: false },
};

/** The views the switch offers, in its order. */
export function availableViews(): ViewEntry[] {
  return VIEW_KINDS.map((k) => VIEWS[k]).filter((v) => v.available);
}

/** The view a page should show for a kind it was asked for: that view if it's offered, else the list. */
export function viewFor(kind: string | null | undefined): ViewEntry {
  const entry = kind && (VIEW_KINDS as readonly string[]).includes(kind) ? VIEWS[kind as ViewKind] : undefined;
  return entry?.available ? entry : VIEWS.list;
}

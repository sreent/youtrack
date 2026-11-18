/**
 * Where a page's links lead: an issue, an article, a list of issues. Signed in, to the team's pages;
 * on a guest's page (D64), to the guest's own, or nowhere where a guest has none, so a board, a report,
 * a plan or a whiteboard drawn for a guest never sends them to a page that asks them to sign in.
 */
import { createContext, useContext } from 'react';
import { Link } from 'react-router';

export interface Places {
  issue(id: string): string;
  /** Null where there's no page for it: a guest reads no article page yet. */
  article(id: string): string | null;
  /** The issues a query finds, or null where there's no list to open. */
  issues(query: string): string | null;
  /** A guest's: nothing shown changes anything, nor reads people. */
  guest: boolean;
}

const TEAM: Places = {
  issue: (id) => `/issues/${id}`,
  article: (id) => `/articles/${id}`,
  issues: (query) => `/issues?q=${encodeURIComponent(query)}`,
  guest: false,
};

export const GUEST_PLACES: Places = {
  issue: (id) => `/public/issues/${id}`,
  article: () => null,
  issues: () => null,
  guest: true,
};

const PlacesContext = createContext<Places>(TEAM);
export const PlacesProvider = PlacesContext.Provider;
export const usePlaces = (): Places => useContext(PlacesContext);

/** A link to an issue's page, wherever the page's reader reads issues. */
export function IssueLink({ id, className, title, children }: { id: string; className?: string; title?: string; children: React.ReactNode }) {
  return (
    <Link className={className} to={usePlaces().issue(id)} title={title}>
      {children}
    </Link>
  );
}

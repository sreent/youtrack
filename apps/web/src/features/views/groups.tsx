import type { IssueField, IssueGroup, IssueListItem, OptionValue, PlanScope } from '@a4a/shared';
import { useCallback, useState, type ReactNode } from 'react';
import { Badge } from '../../components/Badges';
import type { IssueListGroup } from '../issues/IssueList';
import { intlLocale, t } from '../../i18n';

/** What the group of issues with no value is kept by when folded: no value of a field is ever this. */
const NONE = '\u0000none';
export const groupKey = (value: string | null): string => value ?? NONE;

const isOption = (v: unknown): v is OptionValue => Boolean(v) && typeof v === 'object' && 'ordinal' in (v as object);
const isPerson = (v: unknown): v is { login: string; name: string; isBot: boolean } => Boolean(v) && typeof v === 'object' && 'login' in (v as object);

/**
 * A group's head as its rows show its value (Ocean's IssueList): an option in its tone, as a badge with
 * its shape, where it has one; a person by name; a date as a day; a period as its words. The value comes
 * from the server, and its look from an issue of the group, whose first value it is.
 */
function headOf(field: string, value: string | null, issue: IssueListItem | undefined): { name: ReactNode; label: string } {
  if (value === null) {
    const words = t('views.group.none', { field });
    return { name: words, label: words };
  }
  const f: IssueField | undefined = issue?.fields.find((x) => x.name.toLowerCase() === field.toLowerCase());
  const values: unknown[] = Array.isArray(f?.value) ? f.value : [f?.value];
  const option = values.find((v) => isOption(v) && v.name === value) as OptionValue | undefined;
  if (option) return { name: option.tone ? <Badge tone={option.tone}>{option.name}</Badge> : option.name, label: option.name };
  const person = values.find((v) => isPerson(v) && v.login === value) as { login: string; name: string; isBot: boolean } | undefined;
  if (person) return { name: person.isBot ? person.login : person.name, label: person.isBot ? person.login : person.name };
  const named = values.find((v) => Boolean(v) && typeof v === 'object' && 'name' in (v as object) && (v as { name: string }).name === value) as { name: string } | undefined;
  if (named) return { name: named.name, label: named.name };
  const period = values.find((v) => Boolean(v) && typeof v === 'object' && 'presentation' in (v as object)) as { presentation: string } | undefined;
  if (period) return { name: period.presentation, label: period.presentation };
  if (f && (f.type === 'date' || f.type === 'datetime') && /^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const day = new Intl.DateTimeFormat(intlLocale(), { dateStyle: 'medium', timeZone: 'UTC' }).format(new Date(`${value}T00:00:00Z`));
    return { name: day, label: day };
  }
  if (f && (f.type === 'integer' || f.type === 'float') && Number.isFinite(Number(value))) {
    const n = new Intl.NumberFormat(intlLocale()).format(Number(value));
    return { name: n, label: n };
  }
  return { name: value, label: value };
}

/** The page's issues in their groups, in order, each head with the whole result's count. */
export function groupsOf(field: string, issues: IssueListItem[], groups: IssueGroup[]): IssueListGroup[] {
  const counts = new Map(groups.map((g) => [groupKey(g.value), g.count]));
  const out: IssueListGroup[] = [];
  for (const issue of issues) {
    const value = issue.group ?? null;
    const key = groupKey(value);
    let last = out[out.length - 1];
    if (!last || last.key !== key) {
      out.push((last = { key, ...headOf(field, value, issue), none: value === null, count: counts.get(key) ?? 0, issues: [] }));
    }
    last.issues.push(issue);
  }
  return out;
}

const STORE = 'a4a.folded-groups';
/** How many searches' folded groups a browser keeps, the last folded first. */
const KEEP = 50;

type Folds = Record<string, string[]>;
function readFolds(): Folds {
  try {
    const raw = localStorage.getItem(STORE);
    const parsed: unknown = raw ? JSON.parse(raw) : {};
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Folds) : {};
  } catch {
    return {};
  }
}

/**
 * Which groups a person folded in a search grouped by a field, kept in this browser, apart for each
 * person signed in here: folding is each reader's own, not the search's.
 */
export function useFolded(person: string | undefined, scope: PlanScope, field: string | null): [Set<string>, (key: string, folded: boolean) => void] {
  const where = `${person ?? ''}\u0001${'savedSearch' in scope ? `search:${scope.savedSearch}` : `q:${scope.query}`}\u0001${field ?? ''}`;
  const [, rerender] = useState(0);
  const folded = new Set(field ? (readFolds()[where] ?? []) : []);
  const fold = useCallback(
    (key: string, on: boolean) => {
      const all = readFolds();
      const now = new Set(all[where] ?? []);
      if (on) now.add(key);
      else now.delete(key);
      delete all[where];
      const kept: Folds = now.size ? { [where]: [...now] } : {};
      for (const [k, v] of Object.entries(all).slice(0, KEEP - 1)) kept[k] = v;
      try {
        localStorage.setItem(STORE, JSON.stringify(kept));
      } catch {
        // A browser that keeps nothing still folds it, until the page is left.
      }
      memory.set(where, now);
      rerender((n) => n + 1);
    },
    [where],
  );
  return [memory.get(where) ?? folded, fold];
}

/** What was folded on this page, for a browser whose storage keeps nothing. */
const memory = new Map<string, Set<string>>();

import type { CustomerDirectoryEntry } from '@a4a/shared';
import { useId, useMemo, useState } from 'react';
import { formatItems, t } from '../../i18n';

/** At most this many suggestions: enough to choose among names alike, few enough to read. */
const SHOWN = 8;

/** The letters typed, in bold where the name has them, as the query's suggestions show them. */
function Marked({ name, typed }: { name: string; typed: string }) {
  const lower = name.toLowerCase();
  // A name whose lower case is longer or shorter ("İ") would mark the wrong letters: none, then.
  const at = typed && lower.length === name.length ? lower.indexOf(typed.toLowerCase()) : -1;
  if (at < 0) return <span>{name}</span>;
  return (
    <span>
      {name.slice(0, at)}
      <mark>{name.slice(at, at + typed.length)}</mark>
      {name.slice(at + typed.length)}
    </span>
  );
}

/**
 * The customers that match what's typed: by a name that starts with it, then one that has it, then a
 * domain that has it, each in the page's language's order.
 */
function matching(directory: CustomerDirectoryEntry[], typed: string): CustomerDirectoryEntry[] {
  const q = typed.trim().toLowerCase();
  if (!q) return directory.slice(0, SHOWN);
  const rank = (c: CustomerDirectoryEntry) => {
    const name = c.name.toLowerCase();
    if (name.startsWith(q)) return 0;
    if (name.includes(q)) return 1;
    return c.domains.some((d) => d.includes(q)) ? 2 : 3;
  };
  return directory
    .map((c) => ({ c, r: rank(c) }))
    .filter((x) => x.r < 3)
    .sort((a, b) => a.r - b.r || a.c.name.localeCompare(b.c.name))
    .slice(0, SHOWN)
    .map((x) => x.c);
}

/**
 * A customer group's name, with the customers the other desks serve suggested under it as the
 * manager types (D56's revisit), each by its name and its domains: Japanese and Chinese companies'
 * names are long and alike (「〇〇システム株式会社」, 「〇〇システムズ株式会社」), and their domains
 * tell them apart. Ocean's Suggest: the arrows choose, Enter takes the one they're on, Escape puts them
 * away, and what's typed stays the manager's, since a new customer's name is as good as a known one.
 * Taking one hands it over whole, its domains too.
 */
export function CustomerName({
  id,
  value,
  onChange,
  onTake,
  directory,
}: {
  id: string;
  value: string;
  onChange: (name: string) => void;
  onTake: (customer: CustomerDirectoryEntry) => void;
  /** The customers to suggest: the directory less this desk's own groups. */
  directory: CustomerDirectoryEntry[];
}) {
  const listId = `${useId()}-customers`;
  const [focused, setFocused] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const [active, setActive] = useState(-1);
  const [asked, setAsked] = useState(false);
  const shown = useMemo(() => matching(directory, value), [directory, value]);
  // Open as they type, or when they ask with the arrows on an empty field.
  const open = focused && !dismissed && shown.length > 0 && (value.trim() !== '' || asked);
  const optionId = (i: number) => `${listId}-${i}`;

  const take = (c: CustomerDirectoryEntry) => {
    onTake(c);
    setDismissed(true);
    setActive(-1);
  };

  return (
    <div className="suggests">
      <input
        id={id}
        required
        maxLength={100}
        value={value}
        role="combobox"
        aria-autocomplete="list"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-activedescendant={open && active >= 0 ? optionId(active) : undefined}
        autoComplete="off"
        onChange={(e) => {
          onChange(e.target.value);
          setDismissed(false);
          setActive(-1);
        }}
        onFocus={() => setFocused(true)}
        onBlur={() => {
          setFocused(false);
          setAsked(false);
        }}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            if (!shown.length) return;
            e.preventDefault();
            if (!open) {
              setAsked(true);
              setDismissed(false);
              setActive(e.key === 'ArrowDown' ? 0 : shown.length - 1);
              return;
            }
            setActive((a) => (e.key === 'ArrowDown' ? (a + 1) % shown.length : (a <= 0 ? shown.length : a) - 1));
            return;
          }
          // Enter takes only a suggestion the arrows are on; otherwise it does what Enter does in a form.
          if (e.key === 'Enter' && open && active >= 0) {
            e.preventDefault();
            take(shown[active]!);
            return;
          }
          if (e.key === 'Escape' && open) {
            e.preventDefault();
            setDismissed(true);
            setActive(-1);
          }
        }}
      />
      {open ? (
        <ul className="popover options" id={listId} role="listbox" aria-label={t('helpdesk.groups.knownCustomers')}>
          {shown.map((c, i) => (
            <li
              key={c.name}
              id={optionId(i)}
              role="option"
              aria-selected={i === active}
              // Keep the focus in the field: choosing must not blur it first.
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => take(c)}
              onMouseEnter={() => setActive(i)}
            >
              <Marked name={c.name} typed={value.trim()} />
              {/* A space a screen reader hears between the name and its domains; the layout drops it. */}
              {c.domains.length ? <>{' '}<span className="option-kind">{formatItems(c.domains)}</span></> : null}
            </li>
          ))}
        </ul>
      ) : null}
      <span className="hidden" role="status">
        {open ? t('helpdesk.groups.knownCustomersCount', { n: shown.length }) : ''}
      </span>
    </div>
  );
}

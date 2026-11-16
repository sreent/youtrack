import type { User } from '@a4a/shared';
import { useId, useMemo, useRef, useState } from 'react';
import { useUsers } from '../../api/queries';
import { Avatar } from '../../components/Who';

/** "@" and what's typed after it, ending at the caret: the person being named, if any. */
const TYPING = /(^|[^\p{L}\p{N}_@./-])@([A-Za-z0-9._-]{0,40})$/u;

function matches(u: User, typed: string): boolean {
  if (!typed) return true;
  const t = typed.toLowerCase();
  return u.login.toLowerCase().startsWith(t) || u.name.toLowerCase().split(/\s+/).some((w) => w.startsWith(t));
}

/**
 * A text area for Markdown that offers people after an "@", as Ocean's composer draws it: the people
 * whose login or name starts with what's typed, under the field; the arrows choose, Enter or Tab takes
 * one (as "@login "), Escape puts them away. A screen reader hears how many there are.
 */
export function MentionField({
  id,
  value,
  onChange,
  rows = 4,
  placeholder,
  describedBy,
  autoFocus,
}: {
  id: string;
  value: string;
  onChange: (text: string) => void;
  rows?: number;
  placeholder?: string;
  describedBy?: string;
  autoFocus?: boolean;
}) {
  const users = useUsers();
  const listId = useId();
  const ref = useRef<HTMLTextAreaElement>(null);
  const [caret, setCaret] = useState(value.length);
  const [active, setActive] = useState(0);
  const [dismissed, setDismissed] = useState<number | null>(null);

  const typing = useMemo(() => {
    const m = TYPING.exec(value.slice(0, caret));
    return m ? { at: caret - m[2]!.length - 1, typed: m[2]! } : null;
  }, [value, caret]);
  const people = useMemo(() => {
    if (!typing) return [];
    const all = (users.data ?? []).filter((u) => !u.banned && matches(u, typing.typed));
    // People first, then agents; each by name.
    return all.sort((a, b) => Number(a.isBot) - Number(b.isBot) || a.name.localeCompare(b.name)).slice(0, 8);
  }, [users.data, typing]);
  const open = Boolean(typing) && people.length > 0 && dismissed !== typing?.at;

  const take = (u: User) => {
    if (!typing) return;
    const insert = `@${u.login} `;
    const next = value.slice(0, typing.at) + insert + value.slice(caret);
    const at = typing.at + insert.length;
    onChange(next);
    setCaret(at);
    setActive(0);
    requestAnimationFrame(() => {
      ref.current?.focus();
      ref.current?.setSelectionRange(at, at);
    });
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (!open) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((a) => (e.key === 'ArrowDown' ? (a + 1) % people.length : (a - 1 + people.length) % people.length));
    } else if ((e.key === 'Enter' && !e.shiftKey) || (e.key === 'Tab' && !e.shiftKey)) {
      e.preventDefault();
      take(people[Math.min(active, people.length - 1)]!);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      setDismissed(typing!.at);
    }
  };

  const optionId = (i: number) => `${listId}-${i}`;
  return (
    <div className="composer">
      <textarea
        ref={ref}
        id={id}
        value={value}
        rows={rows}
        placeholder={placeholder}
        autoFocus={autoFocus}
        aria-describedby={describedBy}
        aria-autocomplete="list"
        aria-controls={open ? listId : undefined}
        aria-activedescendant={open ? optionId(Math.min(active, people.length - 1)) : undefined}
        onChange={(e) => {
          onChange(e.target.value);
          setCaret(e.target.selectionStart ?? e.target.value.length);
          setActive(0);
        }}
        onSelect={(e) => setCaret(e.currentTarget.selectionStart ?? 0)}
        onKeyDown={onKeyDown}
        onBlur={() => setDismissed(typing?.at ?? null)}
        onFocus={() => setDismissed(null)}
      />
      {open ? (
        <ul className="popover options" id={listId} role="listbox" aria-label="People to mention">
          {people.map((u, i) => (
            <li
              key={u.id}
              id={optionId(i)}
              role="option"
              aria-selected={i === Math.min(active, people.length - 1)}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => take(u)}
              onMouseEnter={() => setActive(i)}
            >
              <span className="who">
                <Avatar kind={u.isBot ? 'agent' : 'person'} name={u.name} small />
                <span className="who-name">{u.isBot ? u.login : u.name}</span>
              </span>
              <span className="option-kind mono">@{u.login}</span>
            </li>
          ))}
        </ul>
      ) : null}
      <span className="hidden" role="status">
        {open ? `${people.length} ${people.length === 1 ? 'person' : 'people'} to mention: up and down to choose, Enter to take one.` : ''}
      </span>
    </div>
  );
}

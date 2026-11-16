import type { FieldValue, IssueDetail, IssueField, ProjectField, User } from '@a4a/shared';
import { formatPeriod } from '@a4a/shared/periods';
import { useEffect, useId, useRef, useState } from 'react';
import { Badge, PriorityMeter } from '../../components/Badges';
import { Avatar, Who } from '../../components/Who';
import { errorText, useUpdateIssue } from './api';
import { isOption, isPeriod, isUser } from './fields';
import { ErrorLine } from '../../components/States';

/** A value triage worked out, waiting for a person. */
export interface Proposal {
  value: string;
  reason: string;
  accept: () => Promise<void>;
}

interface Choice {
  key: string;
  text: string;
  view: React.ReactNode;
  kind?: string;
  /** Its name, when its view doesn't say it in words (a PriorityMeter is named "Priority"). */
  label?: string;
}

const EMPTY: Record<string, string> = { Assignee: 'Unassigned', 'Due date': 'No due date', 'Start date': 'No start date', 'Fix versions': 'None yet' };
const emptyWords = (name: string) => EMPTY[name] ?? 'Not set';

/** A field whose values show as a PriorityMeter, which names itself "Priority" whatever it shows. */
const isMeter = (field: ProjectField) => field.name === 'Priority';

function optionView(field: ProjectField, v: { name: string; tone: FieldValue['tone']; ordinal: number; isResolved: boolean }, wordId?: string) {
  if (field.type === 'state') return <Badge tone={v.tone}>{v.name}</Badge>;
  if (isMeter(field)) return <PriorityMeter value={{ id: '', name: v.name, tone: v.tone, ordinal: v.ordinal, isResolved: v.isResolved }} wordId={wordId} />;
  return <>{v.name}</>;
}

function formatDate(iso: string): string {
  const d = new Date(`${iso}T00:00:00`);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}

/**
 * The value as a button that opens its choices in a listbox, as Ocean's FieldPanel draws it. It is
 * named by its label and itself ("State, In Progress"), or by its label and `valueNameId`, the
 * element whose words say the value, when the view's own name doesn't (a PriorityMeter's).
 */
function ChoiceValue({
  labelId,
  name,
  view,
  valueNameId,
  choices,
  chosen,
  multi,
  proposedId,
  onPick,
}: {
  labelId: string;
  name: string;
  view: React.ReactNode;
  valueNameId?: string;
  choices: Choice[];
  chosen: Set<string>;
  multi: boolean;
  proposedId?: string;
  onPick: (keys: string[]) => void;
}) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const list = useRef<HTMLUListElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const listId = `${id}-options`;

  useEffect(() => {
    if (open) {
      const at = choices.findIndex((c) => chosen.has(c.key));
      setActive(Math.max(0, at));
      list.current?.focus();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const close = (focusButton = true) => {
    setOpen(false);
    if (focusButton) button.current?.focus();
  };
  const pick = (c: Choice) => {
    if (multi) {
      const next = new Set(chosen);
      if (next.has(c.key)) next.delete(c.key);
      else next.add(c.key);
      onPick([...next]);
    } else {
      onPick([c.key]);
      close();
    }
  };
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const n = choices.length;
      setActive((a) => (e.key === 'ArrowDown' ? (a + 1) % n : (a - 1 + n) % n));
    } else if (e.key === 'Home' || e.key === 'End') {
      e.preventDefault();
      setActive(e.key === 'Home' ? 0 : choices.length - 1);
    } else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      if (choices[active]) pick(choices[active]);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      close();
    } else if (e.key === 'Tab') {
      setOpen(false);
    }
  };

  return (
    <>
      <button
        ref={button}
        type="button"
        className={proposedId ? 'fields-value proposed' : 'fields-value'}
        id={`${id}-value`}
        aria-labelledby={`${labelId} ${valueNameId ?? `${id}-value`}`}
        aria-describedby={proposedId}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        onClick={() => setOpen((o) => !o)}
      >
        {view}
      </button>
      {open ? (
        <ul
          ref={list}
          className="popover options"
          id={listId}
          role="listbox"
          aria-label={name}
          aria-multiselectable={multi || undefined}
          aria-activedescendant={choices[active] ? `${listId}-${active}` : undefined}
          tabIndex={-1}
          onKeyDown={onKeyDown}
          onBlur={(e) => {
            if (!e.currentTarget.contains(e.relatedTarget as Node) && e.relatedTarget !== button.current) setOpen(false);
          }}
        >
          {choices.map((c, i) => (
            <li
              key={c.key}
              id={`${listId}-${i}`}
              role="option"
              aria-label={c.label}
              aria-selected={chosen.has(c.key)}
              className={i === active ? 'active' : undefined}
              onMouseDown={(e) => e.preventDefault()}
              onMouseEnter={() => setActive(i)}
              onClick={() => pick(c)}
            >
              {c.view}
              {c.kind ? <span className="option-kind">{c.kind}</span> : null}
            </li>
          ))}
        </ul>
      ) : null}
    </>
  );
}

/** A value typed in place: saved on Enter or when the field is left; Escape puts it back. */
function TextValue({
  labelId,
  initial,
  mono,
  type,
  placeholder,
  proposedId,
  onSave,
}: {
  labelId: string;
  initial: string;
  mono?: boolean;
  type: 'text' | 'date';
  placeholder: string;
  proposedId?: string;
  onSave: (v: string) => Promise<void>;
}) {
  const ownId = useId();
  const [text, setText] = useState(initial);
  const [editingDate, setEditingDate] = useState(false);
  useEffect(() => setText(initial), [initial]);
  const save = async () => {
    if (text.trim() === initial.trim()) return;
    try {
      await onSave(text.trim());
    } catch {
      setText(initial);
    }
  };
  const cls = ['fields-value', mono ? 'mono' : '', proposedId ? 'proposed' : ''].filter(Boolean).join(' ');

  // A date reads as words at rest ("No due date", "12 Nov 2026") and becomes a date field to change it.
  // At rest it's a button, so, like a choice, it's named by its label and the words it shows.
  if (type === 'date' && !editingDate) {
    return (
      <button type="button" className={cls} id={ownId} aria-labelledby={`${labelId} ${ownId}`} aria-describedby={proposedId} onClick={() => setEditingDate(true)}>
        {initial ? formatDate(initial) : <span className="empty">{placeholder}</span>}
      </button>
    );
  }
  return (
    <input
      type={type}
      className={cls}
      aria-labelledby={labelId}
      aria-describedby={proposedId}
      value={text}
      placeholder={placeholder}
      autoFocus={type === 'date'}
      onChange={(e) => setText(e.target.value)}
      onBlur={() => {
        void save();
        setEditingDate(false);
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          (e.target as HTMLInputElement).blur();
        } else if (e.key === 'Escape') {
          setText(initial);
          setEditingDate(false);
        }
      }}
    />
  );
}

function currentText(f: IssueField | undefined): string {
  const v = f?.value;
  if (v === null || v === undefined) return '';
  if (isPeriod(v)) return v.presentation;
  if (typeof v === 'string' || typeof v === 'number') return String(v);
  return '';
}

interface Props {
  issue: IssueDetail;
  fields: ProjectField[];
  users: User[];
  proposals: Map<string, Proposal>;
}

/** Ocean's FieldPanel: an issue's fields beside it, each value a control. */
export function FieldPanel({ issue, fields, users, proposals }: Props) {
  const id = useId();
  const update = useUpdateIssue(issue);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const byId = new Map(issue.fields.map((f) => [f.fieldId, f]));

  const set = async (name: string, value: string | string[] | null) => {
    setErrors((e) => ({ ...e, [name]: '' }));
    try {
      await update({ fields: { [name]: value } });
    } catch (e) {
      setErrors((x) => ({ ...x, [name]: errorText(e) }));
      throw e;
    }
  };

  const accept = async (name: string, p: Proposal) => {
    setBusy(name);
    setErrors((e) => ({ ...e, [name]: '' }));
    try {
      await p.accept();
    } catch (e) {
      setErrors((x) => ({ ...x, [name]: errorText(e) }));
    } finally {
      setBusy(null);
    }
  };

  const people = users.filter((u) => !u.banned);
  const sorted = [...fields].sort((a, b) => a.ordinal - b.ordinal);

  return (
    <aside className="fields" aria-label={`Fields of ${issue.id}`}>
      <dl className="fields-list">
        <div className="fields-row">
          <dt>Project</dt>
          <dd>
            {issue.project.name} <span className="issue-id">{issue.project.key}</span>
          </dd>
        </div>
        {sorted.map((pf) => {
          const f = byId.get(pf.fieldId);
          const labelId = `${id}-${pf.fieldId}`;
          const proposal = proposals.get(pf.name);
          const proposedId = proposal ? `${labelId}-proposed` : undefined;
          let control: React.ReactNode;

          if (pf.type === 'enum' || pf.type === 'state' || pf.type === 'version') {
            const chosenValues = f?.value === null || f?.value === undefined ? [] : Array.isArray(f.value) ? f.value.filter(isOption) : isOption(f.value) ? [f.value] : [];
            const chosen = new Set(chosenValues.map((v) => v.name));
            const values = pf.values.filter((v) => !v.archived || chosen.has(v.name));
            const shown = proposal ? values.find((v) => v.name === proposal.value) : null;
            // A meter's word, not the meter, says which value it is.
            const wordId = isMeter(pf) && !pf.multi && (shown || chosenValues.length) ? `${labelId}-word` : undefined;
            const view = shown ? (
              optionView(pf, shown, wordId)
            ) : chosenValues.length ? (
              pf.multi ? (
                <span className="mono">{chosenValues.map((v) => v.name).join(', ')}</span>
              ) : (
                optionView(pf, values.find((v) => v.name === chosenValues[0]!.name) ?? { ...chosenValues[0]!, tone: chosenValues[0]!.tone }, wordId)
              )
            ) : (
              <span className="empty">{emptyWords(pf.name)}</span>
            );
            control = (
              <ChoiceValue
                labelId={labelId}
                name={pf.name}
                view={view}
                valueNameId={wordId}
                multi={pf.multi}
                chosen={chosen}
                proposedId={proposedId}
                choices={[
                  ...(!pf.required && !pf.multi ? [{ key: '', text: emptyWords(pf.name), view: <span className="empty">{emptyWords(pf.name)}</span> }] : []),
                  ...values.map((v) => {
                    const kind = chosen.has(v.name) && !pf.multi ? 'now' : pf.type === 'state' && v.isResolved ? 'resolves it' : undefined;
                    return { key: v.name, text: v.name, view: optionView(pf, v), kind, label: isMeter(pf) ? [v.name, kind].filter(Boolean).join(', ') : undefined };
                  }),
                ]}
                onPick={(keys) => void set(pf.name, pf.multi ? keys : keys[0] || null).catch(() => {})}
              />
            );
          } else if (pf.type === 'user') {
            const u = f && isUser(f.value) ? f.value : null;
            const proposedUser = proposal ? people.find((p) => p.login === proposal.value || p.name === proposal.value) : null;
            const shownUser = proposedUser ?? u;
            control = (
              <ChoiceValue
                labelId={labelId}
                name={pf.name}
                view={shownUser ? <Who kind={shownUser.isBot ? 'agent' : 'person'} name={shownUser.isBot ? shownUser.login : shownUser.name} small /> : <span className="empty">{emptyWords(pf.name)}</span>}
                multi={false}
                chosen={new Set(u ? [u.login] : [''])}
                proposedId={proposedId}
                choices={[
                  { key: '', text: emptyWords(pf.name), view: <span className="empty">{emptyWords(pf.name)}</span> },
                  ...people.map((p) => ({
                    key: p.login,
                    text: p.name,
                    view: <Who kind={p.isBot ? 'agent' : 'person'} name={p.isBot ? p.login : p.name} small />,
                    kind: u?.login === p.login ? 'now' : undefined,
                  })),
                ]}
                onPick={(keys) => void set(pf.name, keys[0] || null).catch(() => {})}
              />
            );
          } else {
            const initial = pf.type === 'date' ? (typeof f?.value === 'string' ? f.value.slice(0, 10) : '') : currentText(f);
            control = (
              <TextValue
                labelId={labelId}
                initial={proposal ? proposal.value : initial}
                mono={pf.type === 'period' || pf.type === 'integer' || pf.type === 'float'}
                type={pf.type === 'date' ? 'date' : 'text'}
                placeholder={emptyWords(pf.name)}
                proposedId={proposedId}
                onSave={(v) => set(pf.name, v === '' ? null : v)}
              />
            );
          }

          return (
            <div className="fields-row" key={pf.fieldId}>
              <dt id={labelId}>{pf.name}</dt>
              <dd>
                {control}
                {proposal ? (
                  <p className="fields-proposed" id={proposedId}>
                    <Avatar kind="agent" name="triage" small />
                    <span>
                      <strong>triage</strong> {proposal.reason}
                    </span>
                    <button type="button" disabled={busy === pf.name} onClick={() => void accept(pf.name, proposal)}>
                      {busy === pf.name ? 'Accepting…' : 'Accept'}
                    </button>
                  </p>
                ) : null}
                {errors[pf.name] ? (
                  <ErrorLine>{errors[pf.name]}</ErrorLine>
                ) : null}
              </dd>
            </div>
          );
        })}
        <div className="fields-row">
          <dt>Spent time</dt>
          <dd>
            <span className="mono">{issue.spentMinutes ? formatPeriod(issue.spentMinutes) : <span className="empty">None yet</span>}</span>
          </dd>
        </div>
      </dl>
      {proposals.size ? <p className="fields-foot">Dashed values were worked out by an agent: check them, and accept each one you agree with.</p> : null}
    </aside>
  );
}

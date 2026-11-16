import type { FieldValue, IssueDetail, IssueField, ProjectField, User } from '@a4a/shared';
import { isOptionType, isOwnAgent } from '@a4a/shared/constants';
import { formatPeriod } from '@a4a/shared/periods';
import { useEffect, useId, useRef, useState } from 'react';
import { Badge, PriorityMeter } from '../../components/Badges';
import { Avatar, Who } from '../../components/Who';
import { ApiError } from '../../api/client';
import { errorText, useUpdateIssue } from './api';
import { isOption, isPeriod, isUser } from './fields';
import { ErrorLine } from '../../components/States';
import { intlLocale, t } from '../../i18n';

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

const EMPTY: Record<string, string> = { Assignee: t('issues.fieldPanel.unassigned'), 'Due date': t('issues.fieldPanel.noDueDate'), 'Start date': t('issues.fieldPanel.noStartDate'), 'Fix versions': t('issues.fieldPanel.noneYet') };
const emptyWords = (name: string) => EMPTY[name] ?? t('issues.fieldPanel.notSet');

/** A field whose values show as a PriorityMeter, which names itself "Priority" whatever it shows. */
const isMeter = (field: ProjectField) => field.name === 'Priority';

function optionView(field: ProjectField, v: { name: string; tone: FieldValue['tone']; ordinal: number; isResolved: boolean }, wordId?: string) {
  if (field.type === 'state') return <Badge tone={v.tone}>{v.name}</Badge>;
  if (isMeter(field)) return <PriorityMeter value={{ id: '', name: v.name, tone: v.tone, ordinal: v.ordinal, isResolved: v.isResolved }} wordId={wordId} />;
  return <>{v.name}</>;
}

/** A moment in the reader's own time: "20 Nov 2026, 15:30". */
function formatMoment(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString(intlLocale(), { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

/** A moment as a datetime-local input takes it, in the reader's own time. */
function localInput(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function formatDate(iso: string): string {
  const d = new Date(`${iso}T00:00:00`);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString(intlLocale(), { day: 'numeric', month: 'short', year: 'numeric' });
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
  type: 'text' | 'date' | 'datetime-local';
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
  if ((type === 'date' || type === 'datetime-local') && !editingDate) {
    return (
      <button type="button" className={cls} id={ownId} aria-labelledby={`${labelId} ${ownId}`} aria-describedby={proposedId} onClick={() => setEditingDate(true)}>
        {initial ? (type === 'date' ? formatDate(initial) : formatMoment(initial)) : <span className="empty">{placeholder}</span>}
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
      autoFocus={type !== 'text'}
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
  /** False for someone who may only read the issue's project. */
  canEdit?: boolean;
}

const NO_PROPOSALS = new Map<string, Proposal>();

/**
 * Ocean's FieldPanel: an issue's fields beside it, each value a control. Without `canEdit` (someone
 * who may only read the project), each value is its words alone, and nothing waits to be accepted.
 */
export function FieldPanel({ issue, fields, users, proposals: offered, canEdit = true }: Props) {
  const id = useId();
  // Accepting a value is a change to the issue, so only someone who may change it is asked.
  const proposals = canEdit ? offered : NO_PROPOSALS;
  const update = useUpdateIssue(issue);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const byId = new Map(issue.fields.map((f) => [f.fieldId, f]));

  // A change refused for a field it makes required (D41) waits here for that field's value.
  const [waiting, setWaiting] = useState<{ fields: Record<string, string | string[] | null>; need: string } | null>(null);
  const set = async (name: string, value: string | string[] | null) => {
    setErrors((e) => ({ ...e, [name]: '' }));
    const fields = waiting && waiting.need === name ? { ...waiting.fields, [name]: value } : { [name]: value };
    try {
      await update({ fields });
      setWaiting(null);
    } catch (e) {
      const need = e instanceof ApiError ? (e.details as { requiredField?: string } | undefined)?.requiredField : undefined;
      if (need && need !== name) {
        setWaiting({ fields, need });
        setErrors((x) => ({ ...x, [need]: `${errorText(e)}: choose it, and ${Object.keys(fields).join(' and ')} change${Object.keys(fields).length > 1 ? '' : 's'} with it.` }));
        return;
      }
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

  // People, and agents an administrator added; a4a's own agents take no work (D34).
  const people = users.filter((u) => !u.banned && !isOwnAgent(u));
  // A field with a condition shows only while the issue matches it, or while a change waits for it.
  const sorted = [...fields].sort((a, b) => a.ordinal - b.ordinal).filter((pf) => byId.get(pf.fieldId)?.applies !== false || waiting?.need === pf.name);

  return (
    <aside className="fields" aria-label={t('issues.fieldPanel.fieldsOf', { id: issue.id })}>
      <dl className="fields-list">
        <div className="fields-row">
          <dt>{t('issues.fieldPanel.project')}</dt>
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

          if (isOptionType(pf.type) || pf.type === 'group') {
            const raw: unknown[] = f?.value === null || f?.value === undefined ? [] : Array.isArray(f.value) ? f.value : [f.value];
            // A group is named, without a tone or an order of its own.
            type Shown = { name: string; tone: FieldValue['tone']; ordinal: number; isResolved: boolean };
            const chosenValues = raw.flatMap((v): Shown[] =>
              isOption(v) ? [v] : typeof v === 'object' && v !== null && 'name' in v ? [{ name: String((v as { name: unknown }).name), tone: null, ordinal: 0, isResolved: false }] : [],
            );
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
            control = !canEdit ? (
              <span className="fields-value">{view}</span>
            ) : (
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
                    const kind = chosen.has(v.name) && !pf.multi ? 'now' : pf.type === 'state' && v.isResolved ? 'resolves it' : v.owner ? v.owner.name : undefined;
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
            const view = shownUser ? (
              <Who kind={shownUser.isBot ? 'agent' : 'person'} name={shownUser.isBot ? shownUser.login : shownUser.name} small />
            ) : (
              <span className="empty">{emptyWords(pf.name)}</span>
            );
            control = !canEdit ? (
              <span className="fields-value">{view}</span>
            ) : (
              <ChoiceValue
                labelId={labelId}
                name={pf.name}
                view={view}
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
          } else if (pf.type === 'datetime') {
            const iso = typeof f?.value === 'string' ? f.value : '';
            control = !canEdit ? (
              <span className="fields-value">{iso ? formatMoment(iso) : <span className="empty">{emptyWords(pf.name)}</span>}</span>
            ) : (
              <TextValue
                labelId={labelId}
                initial={iso ? localInput(iso) : ''}
                type="datetime-local"
                placeholder={emptyWords(pf.name)}
                proposedId={proposedId}
                onSave={(v) => set(pf.name, v === '' ? null : new Date(v).toISOString())}
              />
            );
          } else {
            const initial = pf.type === 'date' ? (typeof f?.value === 'string' ? f.value.slice(0, 10) : '') : currentText(f);
            const mono = pf.type === 'period' || pf.type === 'integer' || pf.type === 'float';
            control = !canEdit ? (
              <span className={mono ? 'fields-value mono' : 'fields-value'}>
                {initial ? (pf.type === 'date' ? formatDate(initial) : initial) : <span className="empty">{emptyWords(pf.name)}</span>}
              </span>
            ) : (
              <TextValue
                labelId={labelId}
                initial={proposal ? proposal.value : initial}
                mono={mono}
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
                      <strong>{t('issues.fieldPanel.triage')}</strong> {proposal.reason}
                    </span>
                    <button type="button" disabled={busy === pf.name} onClick={() => void accept(pf.name, proposal)}>
                      {busy === pf.name ? t('issues.fieldPanel.accepting') : t('issues.fieldPanel.accept')}
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
          <dt>{t('issues.fieldPanel.spentTime')}</dt>
          <dd>
            <span className="mono">{issue.spentMinutes ? formatPeriod(issue.spentMinutes) : <span className="empty">{t('issues.fieldPanel.noneYet')}</span>}</span>
          </dd>
        </div>
      </dl>
      {proposals.size ? <p className="fields-foot">{t('issues.fieldPanel.dashedValuesWereWorkedOut')}</p> : null}
    </aside>
  );
}

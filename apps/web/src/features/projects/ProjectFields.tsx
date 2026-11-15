import type { Field, FieldType, ProjectField, User } from '@a4a/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { del, put } from '../../api/client';
import { keys } from '../../api/queries';
import { Badge } from '../../components/Badges';
import { errorText, Said, Scroll } from '../common/bits';

export const TYPE_WORDS: Record<FieldType, string> = {
  enum: 'a choice from a list',
  state: 'a state, resolved or not',
  user: 'a person',
  version: 'versions',
  string: 'a line of text',
  text: 'text',
  integer: 'a whole number',
  float: 'a number',
  date: 'a date',
  period: 'a duration, such as 2d 4h',
};

const OPTION_TYPES: FieldType[] = ['enum', 'state', 'version'];

function asText(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (Array.isArray(v)) return v.map(String).join(', ');
  return String(v);
}

/** The control for a field's default: one of its values, a person, or what someone would type. */
function DefaultInput({
  type,
  values,
  users,
  value,
  onChange,
  label,
}: {
  type: FieldType;
  values: { name: string; archived: boolean }[];
  users: User[];
  value: string;
  onChange: (v: string) => void;
  label: string;
}) {
  if (OPTION_TYPES.includes(type))
    return (
      <select value={value} onChange={(e) => onChange(e.target.value)} aria-label={label}>
        <option value="">No default</option>
        {values
          .filter((v) => !v.archived || v.name === value)
          .map((v) => (
            <option key={v.name} value={v.name}>
              {v.name}
            </option>
          ))}
      </select>
    );
  if (type === 'user')
    return (
      <select value={value} onChange={(e) => onChange(e.target.value)} aria-label={label}>
        <option value="">No default</option>
        {users
          .filter((u) => !u.banned)
          .map((u) => (
            <option key={u.id} value={u.login}>
              {u.isBot ? u.login : u.name}
            </option>
          ))}
      </select>
    );
  return (
    <input
      value={value}
      onChange={(e) => onChange(e.target.value)}
      aria-label={label}
      placeholder={type === 'date' ? 'YYYY-MM-DD' : type === 'period' ? '2d 4h' : 'No default'}
    />
  );
}

function FieldRow({ projectKey, field, users, canEdit }: { projectKey: string; field: ProjectField; users: User[]; canEdit: boolean }) {
  const qc = useQueryClient();
  const [required, setRequired] = useState(field.required);
  const [def, setDef] = useState(asText(field.defaultValue));
  const [said, setSaid] = useState<{ text: string; bad?: boolean } | null>(null);
  useEffect(() => {
    setRequired(field.required);
    setDef(asText(field.defaultValue));
  }, [field.required, field.defaultValue]);
  const dirty = required !== field.required || def !== asText(field.defaultValue);
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: keys.projectFields(projectKey) });
    void qc.invalidateQueries({ queryKey: keys.project(projectKey) });
  };
  const save = useMutation({
    mutationFn: () => put<ProjectField[]>(`/projects/${projectKey}/fields/${field.fieldId}`, { required, defaultValue: def.trim() || null }),
    onSuccess: (list) => {
      qc.setQueryData(keys.projectFields(projectKey), list);
      setSaid({ text: 'Saved.' });
      refresh();
    },
    onError: (e) => setSaid({ text: errorText(e), bad: true }),
  });
  const detach = useMutation({
    mutationFn: () => del(`/projects/${projectKey}/fields/${field.fieldId}`),
    onSuccess: () => refresh(),
    onError: (e) => setSaid({ text: errorText(e), bad: true }),
  });
  const shown = field.values.filter((v) => !v.archived);
  return (
    <tr>
      <th scope="row">
        <span className="a4p-row-title">{field.name}</span>
        <span className="a4p-row-about">
          {TYPE_WORDS[field.type]}
          {field.multi ? ', several at once' : ''}
        </span>
      </th>
      <td>
        {shown.length ? (
          <span className="badges">
            {shown.slice(0, 8).map((v) => (
              <Badge key={v.id} tone={v.tone}>
                {v.name}
              </Badge>
            ))}
            {shown.length > 8 ? <span className="a4p-muted a4p-small-text">and {shown.length - 8} more</span> : null}
          </span>
        ) : (
          <span className="a4p-muted">{OPTION_TYPES.includes(field.type) ? 'No values yet' : '—'}</span>
        )}
      </td>
      <td>
        <label className="a4p-check">
          <input type="checkbox" checked={required} onChange={(e) => setRequired(e.target.checked)} disabled={!canEdit} />
          <span className="a4-sr-only">{field.name} is required</span>
          <span aria-hidden="true">{required ? 'Required' : 'Optional'}</span>
        </label>
      </td>
      <td>
        {canEdit ? (
          <DefaultInput type={field.type} values={field.values} users={users} value={def} onChange={setDef} label={`Default for ${field.name}`} />
        ) : (
          <span>{def || <span className="a4p-muted">None</span>}</span>
        )}
      </td>
      {canEdit ? (
        <td className="a4p-tight">
          <span className="a4p-actions">
            <button type="button" className="a4p-small" disabled={!dirty || save.isPending} onClick={() => save.mutate()}>
              {save.isPending ? 'Saving…' : 'Save'}
            </button>
            <button type="button" className="a4p-small" disabled={detach.isPending} onClick={() => detach.mutate()}>
              {detach.isPending ? 'Detaching…' : 'Detach'}
            </button>
          </span>
          <Said text={said?.text} tone={said?.bad ? 'bad' : undefined} />
        </td>
      ) : null}
    </tr>
  );
}

function AttachField({ projectKey, available, users }: { projectKey: string; available: Field[]; users: User[] }) {
  const qc = useQueryClient();
  const [fieldId, setFieldId] = useState('');
  const [required, setRequired] = useState(false);
  const [def, setDef] = useState('');
  const [said, setSaid] = useState<{ text: string; bad?: boolean } | null>(null);
  const chosen = available.find((f) => f.id === fieldId);
  const attach = useMutation({
    mutationFn: () => put<ProjectField[]>(`/projects/${projectKey}/fields/${fieldId}`, { required, defaultValue: def.trim() || null }),
    onSuccess: (list) => {
      qc.setQueryData(keys.projectFields(projectKey), list);
      void qc.invalidateQueries({ queryKey: keys.project(projectKey) });
      setSaid({ text: `${chosen?.name ?? 'The field'} is attached. New and existing issues can have it now.` });
      setFieldId('');
      setRequired(false);
      setDef('');
    },
    onError: (e) => setSaid({ text: errorText(e), bad: true }),
  });
  if (!available.length) return <p className="note">Every field is attached. New fields are made on the Fields page.</p>;
  return (
    <form
      className="a4p-attach"
      onSubmit={(e) => {
        e.preventDefault();
        if (fieldId) attach.mutate();
      }}
    >
      <fieldset className="link-add">
        <legend>Attach a field</legend>
        <div className="a4p-fields">
          <label className="a4p-field">
            <span>Field</span>
            <select value={fieldId} onChange={(e) => {
                setFieldId(e.target.value);
                setDef('');
              }} required>
              <option value="">Choose one</option>
              {available.map((f) => (
                <option key={f.id} value={f.id}>
                  {f.name} ({TYPE_WORDS[f.type]})
                </option>
              ))}
            </select>
          </label>
          {chosen ? (
            <label className="a4p-field">
              <span>Default</span>
              <DefaultInput type={chosen.type} values={chosen.values} users={users} value={def} onChange={setDef} label={`Default for ${chosen.name}`} />
            </label>
          ) : null}
          <label className="a4p-check a4p-check-low">
            <input type="checkbox" checked={required} onChange={(e) => setRequired(e.target.checked)} />
            <span>
              Required
              <small>Every issue in the project must have it.</small>
            </span>
          </label>
        </div>
        <div className="a4p-actions">
          <button type="submit" disabled={!fieldId || attach.isPending}>
            {attach.isPending ? 'Attaching…' : 'Attach it'}
          </button>
          <Said text={said?.text} tone={said?.bad ? 'bad' : undefined} />
        </div>
      </fieldset>
    </form>
  );
}

/** The fields a project's issues have: which are required, their defaults, and attaching more. */
export function ProjectFields({
  projectKey,
  fields,
  all,
  users,
  canEdit,
}: {
  projectKey: string;
  fields: ProjectField[];
  all: Field[];
  users: User[];
  canEdit: boolean;
}) {
  const attached = new Set(fields.map((f) => f.fieldId));
  const available = all.filter((f) => !attached.has(f.id));
  return (
    <>
      <Scroll label="Table of the project's fields">
        <table className="figures a4p-project-fields">
          <thead>
            <tr>
              <th scope="col">Field</th>
              <th scope="col">Its values here</th>
              <th scope="col">Required</th>
              <th scope="col">Default</th>
              {canEdit ? (
                <th scope="col">
                  <span className="a4-sr-only">Change</span>
                </th>
              ) : null}
            </tr>
          </thead>
          <tbody>
            {[...fields]
              .sort((a, b) => a.ordinal - b.ordinal)
              .map((f) => (
                <FieldRow key={f.fieldId} projectKey={projectKey} field={f} users={users} canEdit={canEdit} />
              ))}
          </tbody>
        </table>
      </Scroll>
      {canEdit ? (
        <>
          <p className="note">Detaching hides a field from the project's issues; attach it again and their values come back.</p>
          <AttachField projectKey={projectKey} available={available} users={users} />
        </>
      ) : null}
    </>
  );
}

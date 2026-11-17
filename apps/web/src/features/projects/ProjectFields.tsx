import type { Field, FieldType, ProjectField, User } from '@a4a/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { del, put } from '../../api/client';
import { keys } from '../../api/queries';
import { Badge } from '../../components/Badges';
import { errorText, FormField, Said, Scroll } from '../common/bits';
import { t, tr } from '../../i18n';
import type { ReactNode } from 'react';

export const TYPE_WORDS: Record<FieldType, string> = {
  enum: t('projects.projectFields.aChoiceFromAList2'),
  state: t('projects.projectFields.aStateResolvedOrNot'),
  user: t('projects.projectFields.aPerson'),
  version: t('projects.projectFields.versions'),
  string: t('projects.projectFields.aLineOfText'),
  text: t('projects.projectFields.text'),
  integer: t('projects.projectFields.aWholeNumber'),
  float: t('projects.projectFields.aNumber'),
  date: t('projects.projectFields.aDate'),
  period: t('projects.projectFields.aDurationSuchAs2d'),
  group: t('projects.projectFields.aGroupOfPeople'),
  build: t('projects.projectFields.aBuildFromAList'),
  owned: t('projects.projectFields.aChoiceFromAList'),
  datetime: t('projects.projectFields.aDateAndATime'),
};

const OPTION_TYPES: FieldType[] = ['enum', 'state', 'version'];

function asText(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (Array.isArray(v)) return v.map(String).join(', ');
  return String(v);
}

/** The control for a field's default: one of its values, a person, or what someone would type. */
function DefaultInput({
  id,
  type,
  values,
  users,
  value,
  onChange,
  label,
}: {
  /** Tied to a label by id; or named by `label` where it stands alone, as in a table's row. */
  id?: string;
  type: FieldType;
  values: { name: string; archived: boolean }[];
  users: User[];
  value: string;
  onChange: (v: string) => void;
  label?: string;
}) {
  if (OPTION_TYPES.includes(type))
    return (
      <select id={id} value={value} onChange={(e) => onChange(e.target.value)} aria-label={label}>
        <option value="">{t('projects.projectFields.noDefault')}</option>
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
      <select id={id} value={value} onChange={(e) => onChange(e.target.value)} aria-label={label}>
        <option value="">{t('projects.projectFields.noDefault')}</option>
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
      id={id}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      aria-label={label}
      placeholder={type === 'date' ? t('projects.projectFields.yyyyMmDd') : type === 'period' ? t('projects.projectFields.n2d4h') : t('projects.projectFields.noDefault')}
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
      setSaid({ text: t('projects.projectFields.saved') });
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
      <th scope="row" className="row-head">
        <span className="item-name">{field.name}</span>
        <span className="item-about">
          {TYPE_WORDS[field.type]}
          {field.multi ? t('projects.projectFields.severalAtOnce') : ''}
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
            {shown.length > 8 ? <span className="badge">{tr('projects.projectFields.andMore', { v: shown.length - 8 })}</span> : null}
          </span>
        ) : (
          <span className="muted">{OPTION_TYPES.includes(field.type) ? t('projects.projectFields.noValuesYet') : '—'}</span>
        )}
      </td>
      <td>
        <label className="choice">
          <input type="checkbox" checked={required} onChange={(e) => setRequired(e.target.checked)} disabled={!canEdit} />
          <span className="hidden">{tr('projects.projectFields.isRequired', { name: field.name })}</span>
          <span aria-hidden="true">{required ? t('projects.projectFields.required') : t('projects.projectFields.optional')}</span>
        </label>
      </td>
      <td>
        {canEdit ? (
          <DefaultInput type={field.type} values={field.values} users={users} value={def} onChange={setDef} label={t('projects.projectFields.defaultFor', { name: field.name })} />
        ) : (
          <span>{def || <span className="muted">{t('projects.projectFields.none')}</span>}</span>
        )}
      </td>
      {canEdit ? (
        <td className="fit">
          <span className="cluster">
            <button type="button" className="small" disabled={!dirty || save.isPending} onClick={() => save.mutate()}>
              {save.isPending ? t('projects.projectFields.saving') : t('projects.projectFields.save')}
            </button>
            <button type="button" className="small" disabled={detach.isPending} onClick={() => detach.mutate()}>
              {detach.isPending ? t('projects.projectFields.detaching') : t('projects.projectFields.detach')}
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
      setSaid({ text: t('projects.projectFields.isAttachedNewAndExisting', { v: chosen?.name ?? t('projects.projectFields.theField') }) });
      setFieldId('');
      setRequired(false);
      setDef('');
    },
    onError: (e) => setSaid({ text: errorText(e), bad: true }),
  });
  if (!available.length) return <p className="note">{t('projects.projectFields.everyFieldIsAttachedNew')}</p>;
  return (
    <form
      className="stack"
      onSubmit={(e) => {
        e.preventDefault();
        if (fieldId) attach.mutate();
      }}
    >
      <fieldset className="form-card adding stack">
        <legend>{t('projects.projectFields.attachAField')}</legend>
        <div className="form-fields">
          <FormField label={t('projects.projectFields.field')}>
            {(id) => (
              <select
                id={id}
                value={fieldId}
                onChange={(e) => {
                  setFieldId(e.target.value);
                  setDef('');
                }}
                required
              >
                <option value="">{t('projects.projectFields.chooseOne')}</option>
                {available.map((f) => (
                  <option key={f.id} value={f.id}>
                    {f.name} ({TYPE_WORDS[f.type]})
                  </option>
                ))}
              </select>
            )}
          </FormField>
          {chosen ? (
            <FormField label={t('projects.projectFields.default')}>
              {(id) => <DefaultInput id={id} type={chosen.type} values={chosen.values} users={users} value={def} onChange={setDef} />}
            </FormField>
          ) : null}
          <label className="choice">
            <input type="checkbox" checked={required} onChange={(e) => setRequired(e.target.checked)} />
            <span>{tr('projects.projectFields.requiredEveryIssueInThe', { t0: (c: ReactNode) => <small className="field-help">{c}</small> })}</span>
          </label>
        </div>
        <div className="cluster">
          <button type="submit" disabled={!fieldId || attach.isPending}>
            {attach.isPending ? t('projects.projectFields.attaching') : t('projects.projectFields.attachIt')}
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
      <Scroll label={t('projects.projectFields.tableOfTheProjectS')}>
        <table className="figures middle">
          <thead>
            <tr>
              <th scope="col">{t('projects.projectFields.field')}</th>
              <th scope="col">{t('projects.projectFields.itsValuesHere')}</th>
              <th scope="col">{t('projects.projectFields.required')}</th>
              <th scope="col">{t('projects.projectFields.default')}</th>
              {canEdit ? (
                <th scope="col">
                  <span className="hidden">{t('projects.projectFields.change')}</span>
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
          <p className="note">{t('projects.projectFields.detachingHidesAFieldFrom')}</p>
          <AttachField projectKey={projectKey} available={available} users={users} />
        </>
      ) : null}
    </>
  );
}

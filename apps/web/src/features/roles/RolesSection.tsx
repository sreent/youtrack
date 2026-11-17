import type { Permission, RoleDef } from '@a4a/shared';
import { PERMISSIONS } from '@a4a/shared/constants';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { del, patch, post } from '../../api/client';
import { keys, useRoles } from '../../api/queries';
import { ErrorNote, Loading } from '../../components/States';
import { errorText, FormField, Said, Scroll } from '../common/bits';
import { Confirm } from '../common/Confirm';
import { PERMISSION_ABOUT, PERMISSION_NAMES, roleLabel } from './words';
import { t } from '../../i18n';

interface Draft {
  name: string;
  description: string;
  permissions: Permission[];
}

/** The permissions a role has, as boxes to tick; read is always ticked, as every other needs it. */
function PermissionBoxes({ value, onChange, idPrefix }: { value: Permission[]; onChange: (next: Permission[]) => void; idPrefix: string }) {
  return (
    <fieldset className="stack tight">
      <legend>{t('roles.rolesSection.whatItLetsSomeoneDo')}</legend>
      {PERMISSIONS.map((p) => (
        <label key={p} className="choice" htmlFor={`${idPrefix}-${p}`}>
          <input
            id={`${idPrefix}-${p}`}
            type="checkbox"
            checked={p === 'read' || value.includes(p)}
            disabled={p === 'read'}
            onChange={(e) => onChange(PERMISSIONS.filter((x) => x === 'read' || (x === p ? e.target.checked : value.includes(x))))}
          />
          <span>
            {PERMISSION_NAMES[p]}
            <span className="item-about">{PERMISSION_ABOUT[p]}</span>
          </span>
        </label>
      ))}
    </fieldset>
  );
}

function RoleForm({ initial, submit, busy, label, onCancel, idPrefix }: { initial: Draft; submit: (d: Draft) => void; busy: boolean; label: string; onCancel?: () => void; idPrefix: string }) {
  const [d, setD] = useState<Draft>(initial);
  return (
    <form
      className="stack"
      onSubmit={(e) => {
        e.preventDefault();
        if (d.name.trim()) submit(d);
      }}
    >
      <div className="form-fields">
        <FormField label={t('roles.rolesSection.name')}>{(id) => <input id={id} value={d.name} onChange={(e) => setD({ ...d, name: e.target.value })} required maxLength={60} />}</FormField>
        <FormField label={t('roles.rolesSection.whatItSFor')}>{(id) => <input id={id} value={d.description} onChange={(e) => setD({ ...d, description: e.target.value })} maxLength={500} />}</FormField>
      </div>
      <PermissionBoxes value={d.permissions} onChange={(permissions) => setD({ ...d, permissions })} idPrefix={idPrefix} />
      <div className="cluster">
        <button type="submit" className="primary" disabled={busy || !d.name.trim()}>
          {busy ? t('roles.rolesSection.saving') : label}
        </button>
        {onCancel ? (
          <button type="button" onClick={onCancel}>{t('roles.rolesSection.cancel')}</button>
        ) : null}
      </div>
    </form>
  );
}

function RoleRow({ role }: { role: RoleDef }) {
  const qc = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [said, setSaid] = useState<{ text: string; bad?: boolean } | null>(null);
  const done = () => void qc.invalidateQueries({ queryKey: keys.roles });
  const save = useMutation({
    mutationFn: (d: Draft) => patch<RoleDef>(`/roles/${role.id}`, { ...d, expectedVersion: role.version }),
    onSuccess: (r) => {
      setEditing(false);
      setSaid({ text: t('roles.rolesSection.isSavedEveryoneWithIt', { name: r.name }) });
      done();
    },
    onError: (e) => setSaid({ text: errorText(e), bad: true }),
  });
  const remove = useMutation({
    mutationFn: () => del(`/roles/${role.id}`),
    onSuccess: done,
    onError: (e) => setSaid({ text: errorText(e), bad: true }),
  });
  return (
    <tr>
      <th scope="row" className="row-head">
        {roleLabel(role.id, role.name)}
        {role.builtin ? <span className="item-about">{t('roles.rolesSection.builtIn')}</span> : role.description ? <span className="item-about">{role.description}</span> : null}
      </th>
      <td>
        {editing ? (
          <RoleForm
            initial={{ name: role.name, description: role.description, permissions: role.permissions }}
            submit={(d) => save.mutate(d)}
            busy={save.isPending}
            label={t('roles.rolesSection.saveTheRole')}
            onCancel={() => setEditing(false)}
            idPrefix={`role-${role.id}`}
          />
        ) : (
          role.permissions.map((p) => PERMISSION_NAMES[p]).join(', ')
        )}
        <Said text={said?.text} tone={said?.bad ? 'bad' : undefined} />
      </td>
      <td className="num">{role.uses}</td>
      <td className="fit">
        {role.builtin || editing ? null : (
          <span className="cluster">
            <button type="button" onClick={() => setEditing(true)}>{t('roles.rolesSection.change')}</button>
            <Confirm
              label={t('roles.rolesSection.delete')}
              name={t('roles.rolesSection.delete2', { name: role.name })}
              title={t('roles.rolesSection.deleteTheRole', { name: role.name })}
              confirm={t('roles.rolesSection.deleteIt')}
              onConfirm={() => remove.mutate()}
              disabled={role.uses > 0 || remove.isPending}
              small
              about={role.uses > 0 ? t('roles.rolesSection.giveItsPeopleAndGroups') : t('roles.rolesSection.nobodyHasItInAny')}
            />
          </span>
        )}
      </td>
    </tr>
  );
}

/** Administration's roles (D37): the built-in three, and roles of an administrator's own, as sets of permissions. */
export function RolesSection() {
  const qc = useQueryClient();
  const roles = useRoles();
  const [said, setSaid] = useState<{ text: string; bad?: boolean } | null>(null);
  const [formKey, setFormKey] = useState(0);
  const create = useMutation({
    mutationFn: (d: Draft) => post<RoleDef>('/roles', d),
    onSuccess: (r) => {
      setSaid({ text: t('roles.rolesSection.isMadeGiveItTo', { name: r.name }) });
      setFormKey((k) => k + 1);
      void qc.invalidateQueries({ queryKey: keys.roles });
    },
    onError: (e) => setSaid({ text: errorText(e), bad: true }),
  });
  const list = roles.data ?? [];
  return (
    <section className="card" aria-labelledby="roles">
      <div className="section-head">
        <h2 id="roles">{t('roles.rolesSection.roles')}</h2>
        <span className="note">
          {t('count.roles', { n: list.length })}
        </span>
      </div>
      <p className="note section-note">{t('roles.rolesSection.aRoleIsASet')}</p>
      {roles.isLoading ? <Loading what="loadingLine.roles" /> : null}
      {roles.error ? <ErrorNote error={roles.error} /> : null}
      {list.length ? (
        <Scroll label={t('roles.rolesSection.tableOfRoles')}>
          <table className="figures middle">
            <thead>
              <tr>
                <th scope="col">{t('roles.rolesSection.role')}</th>
                <th scope="col">{t('roles.rolesSection.permissions')}</th>
                <th scope="col" className="num">{t('roles.rolesSection.given')}</th>
                <th scope="col">
                  <span className="hidden">{t('roles.rolesSection.change')}</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {list.map((r) => (
                <RoleRow key={r.id} role={r} />
              ))}
            </tbody>
          </table>
        </Scroll>
      ) : null}
      <fieldset className="form-card adding stack">
        <legend>{t('roles.rolesSection.makeARole')}</legend>
        <RoleForm key={formKey} initial={{ name: '', description: '', permissions: ['read', 'comment'] }} submit={(d) => create.mutate(d)} busy={create.isPending} label={t('roles.rolesSection.makeTheRole')} idPrefix="new-role" />
      </fieldset>
      <Said text={said?.text} tone={said?.bad ? 'bad' : undefined} />
    </section>
  );
}

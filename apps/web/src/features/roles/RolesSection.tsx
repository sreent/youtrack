import type { Permission, RoleDef } from '@a4a/shared';
import { PERMISSIONS } from '@a4a/shared/constants';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { del, patch, post } from '../../api/client';
import { keys, useRoles } from '../../api/queries';
import { ErrorNote, Loading } from '../../components/States';
import { errorText, FormField, Said, Scroll } from '../common/bits';
import { Confirm } from '../common/Confirm';
import { PERMISSION_ABOUT, PERMISSION_NAMES } from './words';

interface Draft {
  name: string;
  description: string;
  permissions: Permission[];
}

/** The permissions a role has, as boxes to tick; read is always ticked, as every other needs it. */
function PermissionBoxes({ value, onChange, idPrefix }: { value: Permission[]; onChange: (next: Permission[]) => void; idPrefix: string }) {
  return (
    <fieldset className="stack tight">
      <legend>What it lets someone do in a project</legend>
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
        <FormField label="Name">{(id) => <input id={id} value={d.name} onChange={(e) => setD({ ...d, name: e.target.value })} required maxLength={60} />}</FormField>
        <FormField label="What it's for">{(id) => <input id={id} value={d.description} onChange={(e) => setD({ ...d, description: e.target.value })} maxLength={500} />}</FormField>
      </div>
      <PermissionBoxes value={d.permissions} onChange={(permissions) => setD({ ...d, permissions })} idPrefix={idPrefix} />
      <div className="cluster">
        <button type="submit" className="primary" disabled={busy || !d.name.trim()}>
          {busy ? 'Saving…' : label}
        </button>
        {onCancel ? (
          <button type="button" onClick={onCancel}>
            Cancel
          </button>
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
      setSaid({ text: `${r.name} is saved: everyone with it may do what it says now.` });
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
        {role.name}
        {role.builtin ? <span className="item-about">Built in</span> : role.description ? <span className="item-about">{role.description}</span> : null}
      </th>
      <td>
        {editing ? (
          <RoleForm
            initial={{ name: role.name, description: role.description, permissions: role.permissions }}
            submit={(d) => save.mutate(d)}
            busy={save.isPending}
            label="Save the role"
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
            <button type="button" onClick={() => setEditing(true)}>
              Change
            </button>
            <Confirm
              label="Delete"
              name={`Delete ${role.name}`}
              title={`Delete the role ${role.name}?`}
              confirm="Delete it"
              onConfirm={() => remove.mutate()}
              disabled={role.uses > 0 || remove.isPending}
              small
              about={role.uses > 0 ? 'Give its people and groups another role first.' : 'Nobody has it, in any project. It can’t be brought back.'}
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
      setSaid({ text: `${r.name} is made. Give it to people and groups in a project's People and access.` });
      setFormKey((k) => k + 1);
      void qc.invalidateQueries({ queryKey: keys.roles });
    },
    onError: (e) => setSaid({ text: errorText(e), bad: true }),
  });
  const list = roles.data ?? [];
  return (
    <section className="card" aria-labelledby="roles">
      <div className="section-head">
        <h2 id="roles">Roles</h2>
        <span className="note">
          {list.length} {list.length === 1 ? 'role' : 'roles'}
        </span>
      </div>
      <p className="note section-note">
        A role is a set of permissions. Projects give roles to people and groups; someone may do in a project what any of their roles there allows. A read-only
        account or token does none of the things that change something, whatever its role.
      </p>
      {roles.isLoading ? <Loading what="roles" /> : null}
      {roles.error ? <ErrorNote error={roles.error} /> : null}
      {list.length ? (
        <Scroll label="Table of roles">
          <table className="figures middle">
            <thead>
              <tr>
                <th scope="col">Role</th>
                <th scope="col">Permissions</th>
                <th scope="col" className="num">
                  Given
                </th>
                <th scope="col">
                  <span className="hidden">Change</span>
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
        <legend>Make a role</legend>
        <RoleForm key={formKey} initial={{ name: '', description: '', permissions: ['read', 'comment'] }} submit={(d) => create.mutate(d)} busy={create.isPending} label="Make the role" idPrefix="new-role" />
      </fieldset>
      <Said text={said?.text} tone={said?.bad ? 'bad' : undefined} />
    </section>
  );
}

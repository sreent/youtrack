/**
 * A project's work types (docs/architecture.md, D43), kept by its managers, and whether work
 * logged in it must say its type.
 */
import type { Project, WorkType } from '@a4a/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useId, useState } from 'react';
import { get, patch, post } from '../../api/client';
import { keys } from '../../api/queries';
import { ErrorLine, ErrorNote } from '../../components/States';
import { errorText } from '../issues/api';

export function WorkTypes({ project, canEdit }: { project: Project; canEdit: boolean }) {
  const id = useId();
  const qc = useQueryClient();
  const key = ['projects', project.key, 'work-types'];
  const types = useQuery({ queryKey: key, queryFn: () => get<WorkType[]>(`/projects/${project.key}/work-types`) });
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const run = async (call: () => Promise<unknown>) => {
    setError(null);
    try {
      await call();
      await Promise.all([qc.invalidateQueries({ queryKey: key }), qc.invalidateQueries({ queryKey: keys.project(project.key) })]);
    } catch (e) {
      setError(errorText(e));
    }
  };
  const required = useMutation({
    mutationFn: (on: boolean) => patch(`/projects/${project.key}`, { settings: { time: { workTypeRequired: on } } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: keys.project(project.key) }),
  });
  const list = types.data ?? [];
  return (
    <div className="stack">
      {types.error ? <ErrorNote error={types.error} /> : null}
      {list.length ? (
        <ul className="chips" aria-label="Work types">
          {list.map((t) => (
            <li key={t.id} className={t.archived ? 'chip muted' : 'chip'}>
              {t.name}
              {t.archived ? <span className="hidden"> (archived)</span> : null}
              {canEdit ? (
                <button type="button" className="link" onClick={() => void run(() => patch(`/work-types/${t.id}`, { archived: !t.archived }))}>
                  {t.archived ? 'Offer again' : 'Archive'}
                  <span className="hidden"> {t.name}</span>
                </button>
              ) : null}
            </li>
          ))}
        </ul>
      ) : (
        <p className="note">No work types yet: work is logged without one.</p>
      )}
      {canEdit ? (
        <>
          <form
            className="cluster"
            aria-labelledby={`${id}-add`}
            onSubmit={(e) => {
              e.preventDefault();
              if (name.trim()) void run(() => post(`/projects/${project.key}/work-types`, { name: name.trim() })).then(() => setName(''));
            }}
          >
            <label id={`${id}-add`} htmlFor={`${id}-name`}>
              Add a work type
            </label>
            <input id={`${id}-name`} value={name} placeholder="Development" onChange={(e) => setName(e.target.value)} />
            <button type="submit" disabled={!name.trim()}>
              Add
            </button>
          </form>
          <label className="choice">
            <input
              type="checkbox"
              checked={required.isPending && required.variables !== undefined ? required.variables : project.settings.time.workTypeRequired}
              onChange={(e) => required.mutate(e.target.checked)}
            />
            <span>Work logged here must say its type</span>
          </label>
        </>
      ) : project.settings.time.workTypeRequired ? (
        <p className="note">Work logged here must say its type.</p>
      ) : null}
      {error ? <ErrorLine>{error}</ErrorLine> : null}
      {required.error ? <ErrorLine>{errorText(required.error)}</ErrorLine> : null}
    </div>
  );
}

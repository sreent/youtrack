import type { Project } from '@a4a/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useNavigate } from 'react-router';
import { post } from '../../api/client';
import { keys } from '../../api/queries';
import { formatList, t } from '../../i18n';
import { Confirm } from '../common/Confirm';
import { errorText, FormField, Said } from '../common/bits';

/** A key as a new project's is checked: a letter, then 1 to 9 letters or digits. */
const KEY = /^[A-Z][A-Z0-9]{1,9}$/;

/**
 * A project's key, the keys it had, and renaming it (D52): its managers type the new key, then
 * type it again in Ocean's Confirm, since everyone who reads its ids meets the change at once.
 */
export function ProjectKey({ project, canEdit }: { project: Project; canEdit: boolean }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [draft, setDraft] = useState('');
  const [said, setSaid] = useState<{ text: string; bad?: boolean } | null>(null);
  const to = draft.trim().toUpperCase();
  const ready = KEY.test(to) && to !== project.key.toUpperCase();
  const rename = useMutation({
    // The key as this page read it: if someone renamed the project meanwhile, the server says so (409).
    mutationFn: () => post<Project>(`/projects/${project.key}/key`, { key: to, expectedKey: project.key }),
    onSuccess: (p) => {
      setDraft('');
      setSaid({ text: t('page.project.keyRenamed', { from: project.key, to: p.key }) });
      qc.setQueryData(keys.project(p.key), p);
      // Every id on every page now reads under the new key.
      void qc.invalidateQueries();
      navigate(`/projects/${p.key}`, { replace: true });
    },
    onError: (e) => setSaid({ text: errorText(e), bad: true }),
  });
  return (
    <div className="stack">
      <p>{t('page.project.keyAbout', { key: project.key })}</p>
      {project.formerKeys.length ? <p className="note">{t('page.project.keyFormer', { keys: formatList(project.formerKeys) })}</p> : null}
      {canEdit ? (
        <form
          className="form"
          onSubmit={(e) => {
            e.preventDefault();
          }}
        >
          <fieldset className="unframed form" disabled={rename.isPending}>
            <FormField label={t('page.project.keyNew')} help={t('page.project.keyNewHelp')}>
              {(id, helpId) => (
                <input
                  id={id}
                  className="mono"
                  value={draft}
                  onChange={(e) => {
                    setDraft(e.target.value);
                    setSaid(null);
                  }}
                  maxLength={10}
                  autoComplete="off"
                  autoCapitalize="characters"
                  spellCheck={false}
                  aria-describedby={helpId}
                />
              )}
            </FormField>
          </fieldset>
          <div className="cluster">
            <Confirm
              label={t('page.project.keyRename')}
              title={t('page.project.keyRenameTitle', { from: project.key, to })}
              about={t('page.project.keyRenameAbout', { from: project.key, to })}
              confirm={t('page.project.keyRenameIt')}
              typed={{ label: t('page.project.keyTypeAgain', { key: to }), value: to }}
              danger={false}
              disabled={!ready || rename.isPending}
              onConfirm={() => rename.mutate()}
            />
            <Said text={said?.text} tone={said?.bad ? 'bad' : undefined} />
          </div>
        </form>
      ) : null}
    </div>
  );
}

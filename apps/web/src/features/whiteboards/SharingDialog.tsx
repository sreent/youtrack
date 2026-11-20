/**
 * Who else reads a person's own whiteboard (D58's revisit): its owner says everyone signed in, or the
 * people and groups named, and the page says it in the whiteboard's own words.
 */
import type { Whiteboard } from '@a4a/shared';
import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { ErrorNote } from '../../components/States';
import { FormField } from '../common/bits';
import { LimitPicker, limitOf, type Limit } from '../issues/VisibleTo';
import { setWhiteboardSharing, whiteboardKeys } from './api';
import { t } from '../../i18n';

export function SharingDialog({ board, onClose }: { board: Whiteboard; onClose: () => void }) {
  const qc = useQueryClient();
  const [share, setShare] = useState<'everyone' | 'limited'>(board.share);
  const [sharedWith, setSharedWith] = useState<Limit>(limitOf(board.sharedWith) ?? { users: [], groups: [] });
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const next = await setWhiteboardSharing(board.id, { share, ...(share === 'limited' ? { sharedWith } : {}) });
      qc.setQueryData(whiteboardKeys.detail(board.id), (old: { whiteboard: Whiteboard; elements: unknown[]; cards: unknown[]; viewers: unknown[] } | undefined) => (old ? { ...old, whiteboard: next } : old));
      onClose();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="card" aria-labelledby="whiteboard-sharing-title">
      <h2 id="whiteboard-sharing-title">{t('page.whiteboards.whoReadsIt')}</h2>

      <div className="form-fields">
        <FormField label={t('page.whiteboards.whoReadsIt')}>
          {(id) => (
            <select id={id} value={share} onChange={(e) => setShare(e.target.value as 'everyone' | 'limited')}>
              <option value="everyone">{t('page.whiteboards.everyoneSignedIn')}</option>
              <option value="limited">{t('page.whiteboards.limitedToSome')}</option>
            </select>
          )}
        </FormField>
      </div>
      {share === 'limited' ? <LimitPicker value={sharedWith} onChange={setSharedWith} legend={t('page.whiteboards.whoElse')} /> : null}
      {error ? <ErrorNote error={error} /> : null}
      <div className="cluster">
        <button type="button" className="primary" onClick={() => void save()} disabled={busy || (share === 'limited' && !sharedWith.users.length && !sharedWith.groups.length)}>
          {t('page.whiteboards.saveSharing')}
        </button>
        <button type="button" onClick={onClose} disabled={busy}>
          {t('editor.visualEditor.cancel')}
        </button>
      </div>
    </section>
  );
}

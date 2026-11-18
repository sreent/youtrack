/**
 * Whiteboards (D58): those of every project you read, or of one (`?project=`), and a new one in a
 * project where you may change issues. Who reads the project reads its whiteboards.
 */
import type { Project } from '@a4a/shared';
import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { useProjects } from '../api/queries';
import { agoSaid, Chip } from '../components/Badges';
import { Icon } from '../components/Icon';
import { Empty, ErrorNote, Loading, PageHead } from '../components/States';
import { FormField } from '../features/common/bits';
import { createWhiteboard, useWhiteboards, whiteboardKeys } from '../features/whiteboards/api';
import { WHITEBOARD_LIMITS } from '@a4a/shared/constants';
import { t } from '../i18n';

export default function WhiteboardsPage() {
  const [params, setParams] = useSearchParams();
  const project = params.get('project') ?? '';
  const list = useWhiteboards(project);
  const projects = useProjects().data ?? [];
  const writable = projects.filter((p: Project) => p.access.write && !p.archived);
  const [name, setName] = useState('');
  const [where, setWhere] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const qc = useQueryClient();
  const navigate = useNavigate();
  const target = where || (writable.some((p) => p.key === project) ? project : (writable[0]?.key ?? ''));
  return (
    <>
      <PageHead title={t('page.whiteboards.title')} about={t('page.whiteboards.about')} />
      {writable.length ? (
        <section className="card" aria-labelledby="new-whiteboard">
          <h2 id="new-whiteboard">{t('page.whiteboards.new')}</h2>
          <form
            className="form"
            onSubmit={async (e) => {
              e.preventDefault();
              setBusy(true);
              setError(null);
              try {
                const w = await createWhiteboard({ project: target, name: name.trim() });
                void qc.invalidateQueries({ queryKey: whiteboardKeys.all });
                navigate(`/whiteboards/${w.id}`);
              } catch (err) {
                setError(err);
              } finally {
                setBusy(false);
              }
            }}
          >
            <div className="form-fields">
              <FormField label={t('page.whiteboards.name')}>
                {(id) => <input id={id} required maxLength={WHITEBOARD_LIMITS.name} value={name} onChange={(e) => setName(e.target.value)} />}
              </FormField>
              <FormField label={t('page.whiteboards.project')} help={t('page.whiteboards.projectHelp')}>
                {(id, help) => (
                  <select id={id} aria-describedby={help} value={target} onChange={(e) => setWhere(e.target.value)}>
                    {writable.map((p) => (
                      <option key={p.key} value={p.key}>
                        {`${p.name} (${p.key})`}
                      </option>
                    ))}
                  </select>
                )}
              </FormField>
            </div>
            {error ? <ErrorNote error={error} /> : null}
            <div className="cluster">
              <button type="submit" className="primary" disabled={busy || !name.trim() || !target}>
                {t('page.whiteboards.create')}
              </button>
            </div>
          </form>
        </section>
      ) : null}
      <div className="cluster">
        <FormField label={t('page.whiteboards.showProject')}>
          {(id) => (
            <select id={id} value={project} onChange={(e) => setParams(e.target.value ? { project: e.target.value } : {})}>
              <option value="">{t('page.whiteboards.allProjects')}</option>
              {projects.map((p) => (
                <option key={p.key} value={p.key}>
                  {`${p.name} (${p.key})`}
                </option>
              ))}
            </select>
          )}
        </FormField>
      </div>
      {list.isLoading ? <Loading what="loadingLine.whiteboards" /> : null}
      {list.error ? <ErrorNote error={list.error} /> : null}
      {list.data && !list.data.length ? <Empty title={t('page.whiteboards.none')}>{t('page.whiteboards.noneAbout')}</Empty> : null}
      {list.data?.length ? (
        <section className="card" aria-labelledby="whiteboards-title">
          <h2 id="whiteboards-title" className="hidden">
            {t('page.whiteboards.title')}
          </h2>
          <ul className="directory">
            {list.data.map((w) => (
              <li key={w.id}>
                <Icon name="whiteboard" />
                <div className="directory-name">
                  <Link to={`/whiteboards/${w.id}`}>{w.name}</Link>
                  <Chip mono>{w.project.key}</Chip>
                </div>
                <p className="note">{t('page.whiteboards.row', { n: w.elements, when: agoSaid(w.updatedAt) })}</p>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </>
  );
}

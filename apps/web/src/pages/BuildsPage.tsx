import { Link, useParams } from 'react-router';
import { useProject } from '../api/queries';
import { ErrorNote, Loading, PageHead } from '../components/States';
import { BuildList } from '../features/builds/Builds';
import { t } from '../i18n';

/** A project's builds from CI (D46): newest first, and what each did to the issues its commits name. */
export default function BuildsPage() {
  const { key = '' } = useParams();
  const project = useProject(key);
  if (project.isLoading) return <Loading what="loadingLine.project" />;
  if (project.error) return <ErrorNote error={project.error} />;
  const p = project.data!;
  return (
    <>
      <PageHead
        title={t('page.builds.buildsOf', { name: p.name })}
        crumbs={
          <>
            <Link to={`/projects/${p.key}`}>{p.name}</Link>
          </>
        }
        about={t('page.builds.eachBuildCiReportedNewest')}
      />
      <section className="card" aria-label={t('page.builds.buildsOf', { name: p.name })}>
        <BuildList project={p.key} />
      </section>
    </>
  );
}

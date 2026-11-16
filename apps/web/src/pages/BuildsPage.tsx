import { Link, useParams } from 'react-router';
import { useProject } from '../api/queries';
import { ErrorNote, Loading, PageHead } from '../components/States';
import { BuildList } from '../features/builds/Builds';

/** A project's builds from CI (D46): newest first, and what each did to the issues its commits name. */
export default function BuildsPage() {
  const { key = '' } = useParams();
  const project = useProject(key);
  if (project.isLoading) return <Loading what="the project" />;
  if (project.error) return <ErrorNote error={project.error} />;
  const p = project.data!;
  return (
    <>
      <PageHead
        title={`Builds of ${p.name}`}
        crumbs={
          <>
            <Link to={`/projects/${p.key}`}>{p.name}</Link>
          </>
        }
        about="Each build CI reported, newest first. One that passed marks the resolved issues its commits name as fixed in it; the rest it leaves, and says why."
      />
      <section className="card" aria-label={`Builds of ${p.name}`}>
        <BuildList project={p.key} />
      </section>
    </>
  );
}

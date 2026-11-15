import type { Board } from '@a4a/shared';
import { Link } from 'react-router';
import { Icon } from '../components/Icon';
import { Empty, ErrorNote, Loading, PageHead } from '../components/States';
import { useBoards } from '../features/board/api';
import { plural } from '../features/plan/format';
import '../features/board/board.css';

function projectsOf(b: Board): string {
  if (!b.projects.length) return 'No project';
  return b.projects.map((p) => `${p.name} (${p.key})`).join(', ');
}

export default function BoardsPage() {
  const boards = useBoards();
  return (
    <>
      <PageHead title="Boards" about="Each board shows a project's issues as columns of how they stand. A sprint board shows one sprint at a time; a kanban board shows everything that's on it." />
      {boards.isLoading ? <Loading what="boards" /> : null}
      {boards.error ? <ErrorNote error={boards.error} /> : null}
      {boards.data && boards.data.length === 0 ? (
        <Empty title="No boards yet">
          A board shows a project's issues as columns of their state. Make one through the API, with <code>POST /api/v1/boards</code>, and it shows here.
        </Empty>
      ) : null}
      {boards.data && boards.data.length > 0 ? (
        <section className="card a4-boards-card" aria-labelledby="boards-title">
          <h2 id="boards-title" className="hidden">
            All boards
          </h2>
          <ul className="a4-boards">
            {boards.data.map((b) => (
              <li key={b.id}>
                <Icon name="board" />
                <div className="a4-row">
                  <Link className="a4-board-name" to={`/boards/${b.id}`}>
                    {b.name}
                  </Link>
                  <span className="chip">{b.sprintsEnabled ? 'Sprints' : 'Kanban'}</span>
                </div>
                <p className="note">
                  {projectsOf(b)} · {plural(b.columns.length, 'column')} by {b.columnField}
                  {b.swimlaneField ? `, in lanes by ${b.swimlaneField}` : ''}
                </p>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </>
  );
}

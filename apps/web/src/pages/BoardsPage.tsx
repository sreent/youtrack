import type { Board } from '@a4a/shared';
import { Link } from 'react-router';
import { Icon } from '../components/Icon';
import { Empty, ErrorNote, Loading, PageHead } from '../components/States';
import { useBoards } from '../features/board/api';
import { t, tr } from '../i18n';

function projectsOf(b: Board): string {
  if (!b.projects.length) return t('page.boards.noProject');
  return b.projects.map((p) => `${p.name} (${p.key})`).join(', ');
}

export default function BoardsPage() {
  const boards = useBoards();
  return (
    <>
      <PageHead title={t('page.boards.boards')} about={t('page.boards.eachBoardShowsAProject')} />
      {boards.isLoading ? <Loading what="boards" /> : null}
      {boards.error ? <ErrorNote error={boards.error} /> : null}
      {boards.data && boards.data.length === 0 ? (
        <Empty title={t('page.boards.noBoardsYet')}>{tr('page.boards.aBoardShowsAProject', { code: <code>POST /api/v1/boards</code> })}</Empty>
      ) : null}
      {boards.data && boards.data.length > 0 ? (
        <section className="card" aria-labelledby="boards-title">
          <h2 id="boards-title" className="hidden">{t('page.boards.allBoards')}</h2>
          <ul className="directory">
            {boards.data.map((b) => (
              <li key={b.id}>
                <Icon name="board" />
                <div className="directory-name">
                  <Link to={`/boards/${b.id}`}>
                    {b.name}
                  </Link>
                  <span className="chip">{b.sprintsEnabled ? t('page.boards.sprints') : t('page.boards.kanban')}</span>
                </div>
                <p className="note">{tr('page.boards.columnsBy', { projectsOf: projectsOf(b), n: b.columns.length, columnField: b.columnField, v: b.swimlaneField ? t('page.boards.inLanesBy', { swimlaneField: b.swimlaneField }) : '' })}</p>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </>
  );
}

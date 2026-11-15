import type { Sprint } from '@a4a/shared';
import { useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router';
import { ErrorNote, Loading, PageHead } from '../components/States';
import { useBoardView } from '../features/board/api';
import { Board, type CommandAsk } from '../features/board/Board';
import { CommandBar } from '../features/issues/CommandBar';
import { span } from '../features/plan/dates';
import '../features/board/board.css';

function sprintOption(s: Sprint): string {
  const dates = s.startDate && s.endDate ? `, ${span(s.startDate, s.endDate)}` : '';
  return `${s.name}${dates}`;
}

function SprintPicker({ sprints, current, onPick }: { sprints: Sprint[]; current: string | null; onPick: (id: string) => void }) {
  const open = sprints.filter((s) => !s.archived);
  const archived = sprints.filter((s) => s.archived);
  return (
    <label className="a4-sprint-pick">
      Sprint
      <select value={current ?? ''} onChange={(e) => onPick(e.target.value)}>
        {open.map((s) => (
          <option key={s.id} value={s.id}>
            {sprintOption(s)}
          </option>
        ))}
        {archived.length ? (
          <optgroup label="Archived">
            {archived.map((s) => (
              <option key={s.id} value={s.id}>
                {sprintOption(s)}
              </option>
            ))}
          </optgroup>
        ) : null}
      </select>
    </label>
  );
}

export default function BoardPage() {
  const { id } = useParams();
  const [params, setParams] = useSearchParams();
  const sprintParam = params.get('sprint') ?? undefined;
  const view = useBoardView(id, sprintParam);
  const [ask, setAsk] = useState<CommandAsk | null>(null);
  const v = view.data;

  const crumbs = (
    <>
      <Link to="/boards">Boards</Link>
      <span className="sep" aria-hidden="true">
        /
      </span>
    </>
  );

  if (view.isLoading) return <Loading what="the board" />;
  if (view.error || !v) {
    return (
      <>
        <PageHead title="Board" crumbs={crumbs} />
        <ErrorNote error={view.error} />
      </>
    );
  }

  const projects = v.board.projects.map((p) => p.name).join(', ');
  const kind = v.board.sprintsEnabled ? 'A sprint board' : 'A kanban board';
  const total = v.columns.reduce((n, c) => n + c.count, 0);
  return (
    <>
      <PageHead
        title={v.board.name}
        crumbs={crumbs}
        about={`${kind} for ${projects || 'no project'}, in columns by ${v.board.columnField}${v.board.swimlaneField ? ` and lanes by ${v.board.swimlaneField}` : ''}.`}
        actions={
          v.sprints.length > 1 ? (
            <SprintPicker
              sprints={v.sprints}
              current={v.sprint?.id ?? null}
              onPick={(sprint) => setParams((p) => {
                const next = new URLSearchParams(p);
                next.set('sprint', sprint);
                return next;
              })}
            />
          ) : null
        }
      />
      {/* Not a card: the board is the page's own surface, as Ocean's preview draws it. */}
      <div className="a4-stack">
        {v.board.sprintsEnabled && !v.sprint ? <p className="note">This board has no sprint yet, so it shows every issue on it.</p> : null}
        {total === 0 ? <p className="note">{v.sprint ? `Nothing is in ${v.sprint.name} yet.` : 'There are no issues on this board yet.'}</p> : null}
        <Board view={v} onCommand={setAsk} />
      </div>
      <CommandBar issues={ask?.issues ?? []} open={ask !== null} initial={ask?.initial} onClose={() => setAsk(null)} />
    </>
  );
}

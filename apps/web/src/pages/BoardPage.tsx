import type { Sprint } from '@a4a/shared';
import { useEffect, useId, useRef, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router';
import { ErrorNote, Loading, PageHead } from '../components/States';
import { useBoardView } from '../features/board/api';
import { Board, type CommandAsk } from '../features/board/Board';
import { CommandBar } from '../features/issues/CommandBar';
import { span } from '../features/plan/dates';

function sprintOption(s: Sprint): string {
  const dates = s.startDate && s.endDate ? `, ${span(s.startDate, s.endDate)}` : '';
  return `${s.name}${dates}`;
}

function SprintPicker({ sprints, current, onPick }: { sprints: Sprint[]; current: string | null; onPick: (id: string) => void }) {
  const open = sprints.filter((s) => !s.archived);
  const archived = sprints.filter((s) => s.archived);
  const id = useId();
  return (
    <span className="form-field inline">
      <label htmlFor={id}>Sprint</label>
      <select id={id} value={current ?? ''} onChange={(e) => onPick(e.target.value)}>
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
    </span>
  );
}

export default function BoardPage() {
  const { id } = useParams();
  const [params, setParams] = useSearchParams();
  const sprintParam = params.get('sprint') ?? undefined;
  const view = useBoardView(id, sprintParam);
  const [ask, setAsk] = useState<CommandAsk | null>(null);
  const v = view.data;

  // A command moves the card to another column, so the button that opened it is gone when the
  // dialog closes. Put the focus back on the card's id, wherever it now is, whichever comes
  // last: the dialog closing or the board being read again.
  const refocus = useRef<{ id: string; until: number } | null>(null);
  const askFor = (a: CommandAsk) => {
    refocus.current = { id: a.issues[0]!.id, until: Infinity };
    setAsk(a);
  };
  const closeAsk = () => {
    if (refocus.current) refocus.current.until = Date.now() + 3000;
    setAsk(null);
  };
  useEffect(() => {
    const r = refocus.current;
    if (!r || ask) return;
    if (Date.now() > r.until) {
      refocus.current = null;
      return;
    }
    // Focus still in the dialog that just closed is about to fall to the page: it's lost too.
    const active = document.activeElement;
    if (active && active !== document.body && !active.closest('dialog:not([open])')) return;
    document.querySelector<HTMLElement>(`li[data-issue="${r.id}"] button.issue-id`)?.focus();
  }, [ask, v]);

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
  const points = v.points !== null ? ` ${v.sprint ? v.sprint.name : 'It'} holds ${v.points} story points.` : '';
  return (
    <>
      <PageHead
        title={v.board.name}
        crumbs={crumbs}
        about={`${kind} for ${projects || 'no project'}, in columns by ${v.board.columnField}${v.board.swimlaneField ? ` and lanes by ${v.board.swimlaneField}` : ''}.${points}`}
        actions={
          <>
            {v.sprints.length > 1 ? (
              <SprintPicker
                sprints={v.sprints}
                current={v.sprint?.id ?? null}
                onPick={(sprint) => setParams((p) => {
                  const next = new URLSearchParams(p);
                  next.set('sprint', sprint);
                  return next;
                })}
              />
            ) : null}
            {v.board.sprintsEnabled ? (
              <Link className="button" to={`/boards/${v.board.id}/plan`}>
                Plan sprints
              </Link>
            ) : null}
            {v.sprint?.startDate && v.sprint.endDate ? (
              <Link className="button" to={`/reports/burndown?board=${v.board.id}&sprint=${v.sprint.id}`}>
                {v.sprint.name}'s burndown
              </Link>
            ) : null}
          </>
        }
      />
      {/* Not a card: the board is the page's own surface, as Ocean's preview draws it. */}
      <div className="stack">
        {v.board.sprintsEnabled && !v.sprint ? <p className="note">This board has no sprint yet, so it shows every issue on it.</p> : null}
        {total === 0 ? <p className="note">{v.sprint ? `Nothing is in ${v.sprint.name} yet.` : 'There are no issues on this board yet.'}</p> : null}
        <Board view={v} onCommand={askFor} />
      </div>
      <CommandBar issues={ask?.issues ?? []} open={ask !== null} initial={ask?.initial} onClose={closeAsk} />
    </>
  );
}

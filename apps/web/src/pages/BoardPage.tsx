import type { Board as BoardSettings, Sprint } from '@a4a/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useEffect, useId, useRef, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router';
import { patch } from '../api/client';
import { useProjects } from '../api/queries';
import { ErrorLine, ErrorNote, Loading, PageHead } from '../components/States';
import { useBoardView } from '../features/board/api';
import { Board, type CommandAsk } from '../features/board/Board';
import { errorText } from '../features/issues/api';
import { CommandBar } from '../features/issues/CommandBar';
import { span } from '../features/plan/dates';
import { formatItems, formatList, t, tr } from '../i18n';

/**
 * Whether the board's lanes keep their own order (D65): its managers turn it on and off here; to
 * anyone else it's said, while it's on, since cards are then ranked within their lanes.
 */
function LaneOrder({ board }: { board: BoardSettings }) {
  const qc = useQueryClient();
  const helpId = useId();
  const [said, setSaid] = useState('');
  // What was chosen shows from the click itself until the save settles: a mutation's own pending
  // state comes a tick later, and meanwhile the box would show its old state.
  const [asked, setAsked] = useState<boolean | null>(null);
  const save = useMutation({
    mutationFn: (laneOrder: boolean) => patch<BoardSettings>(`/boards/${board.id}`, { laneOrder }),
    onSuccess: async (b) => {
      await qc.invalidateQueries({ queryKey: ['boards'] });
      setSaid(b.laneOrder ? t('page.board.laneOrderTurnedOn') : t('page.board.laneOrderTurnedOff'));
    },
    onSettled: () => setAsked(null),
  });
  if (!board.manageable) return board.laneOrder ? <p className="note">{t('page.board.laneOrderOn')}</p> : null;
  return (
    <div className="stack tight">
      <label className="choice">
        <input
          type="checkbox"
          checked={asked ?? board.laneOrder}
          disabled={asked !== null || save.isPending}
          aria-describedby={helpId}
          onChange={(e) => {
            setSaid('');
            setAsked(e.target.checked);
            save.mutate(e.target.checked);
          }}
        />
        <span>
          {t('page.board.laneOrder')} <small className="field-help" id={helpId}>{t('page.board.laneOrderHelp')}</small>
        </span>
      </label>
      <p role="status" className="hidden">{said}</p>
      {save.error ? <ErrorLine>{errorText(save.error)}</ErrorLine> : null}
    </div>
  );
}

/**
 * A board's search, as the Issues page reads it (D72): its projects, and its query within them, so it
 * opens in any view. Its sort, when it has one, stays the search's own.
 */
export function boardSearch(board: BoardSettings, seen?: Set<string>): string {
  // Only the projects the reader sees: a key they can't see would make the search one they can't run.
  const keys = board.projects.map((p) => p.key).filter((k) => !seen || seen.has(k));
  const projects = `project: ${(keys.length ? keys : board.projects.map((p) => p.key)).join(', ')}`;
  const query = board.query?.trim() ?? '';
  if (!query) return projects;
  const sort = /\bsort\s+by\s*:/i.exec(query);
  const where = (sort ? query.slice(0, sort.index) : query).trim();
  const order = sort ? query.slice(sort.index).trim() : '';
  return [projects, where ? `(${where})` : '', order].filter(Boolean).join(' ');
}

function sprintOption(s: Sprint): string {
  return formatItems(s.startDate && s.endDate ? [s.name, span(s.startDate, s.endDate)] : [s.name]);
}

export function SprintPicker({ sprints, current, onPick }: { sprints: Sprint[]; current: string | null; onPick: (id: string) => void }) {
  const open = sprints.filter((s) => !s.archived);
  const archived = sprints.filter((s) => s.archived);
  const id = useId();
  return (
    <span className="form-field inline">
      <label htmlFor={id}>{t('page.board.sprint')}</label>
      <select id={id} value={current ?? ''} onChange={(e) => onPick(e.target.value)}>
        {open.map((s) => (
          <option key={s.id} value={s.id}>
            {sprintOption(s)}
          </option>
        ))}
        {archived.length ? (
          <optgroup label={t('page.board.archived')}>
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
  const seen = useProjects();
  const seenKeys = seen.data ? new Set(seen.data.map((p) => p.key)) : undefined;
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
      <Link to="/boards">{t('page.board.boards')}</Link>
      <span className="sep" aria-hidden="true">
        /
      </span>
    </>
  );

  if (view.isLoading) return <Loading what="loadingLine.board" />;
  if (view.error || !v) {
    return (
      <>
        <PageHead title={t('page.board.board')} crumbs={crumbs} />
        <ErrorNote error={view.error} />
      </>
    );
  }

  const projects = formatList(v.board.projects.map((p) => p.name));
  const kind = v.board.sprintsEnabled ? t('page.board.aSprintBoard') : t('page.board.aKanbanBoard');
  const total = v.columns.reduce((n, c) => n + c.count, 0);
  const points = v.points !== null ? t('page.board.holdsStoryPoints', { v: v.sprint?.name ?? '', named: v.sprint ? 'yes' : 'no', points: v.points }) : '';
  return (
    <>
      <PageHead
        title={v.board.name}
        crumbs={crumbs}
        about={t('page.board.forInColumnsBy', { kind: kind, v: projects || t('page.board.noProject'), columnField: v.board.columnField, v2: v.board.swimlaneField ? t('page.board.andLanesBy', { swimlaneField: v.board.swimlaneField }) : '', points: points })}
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
              <Link className="button" to={`/boards/${v.board.id}/plan`}>{t('page.board.planSprints')}</Link>
            ) : null}
            <Link className="button" to={`/issues?q=${encodeURIComponent(boardSearch(v.board, seenKeys))}`}>{t('views.board.openInIssues')}</Link>
            {v.sprint?.startDate && v.sprint.endDate ? (
              <Link className="button" to={`/reports/burndown?board=${v.board.id}&sprint=${v.sprint.id}`}>{tr('page.board.sBurndown', { name: v.sprint.name })}</Link>
            ) : null}
          </>
        }
      />
      {/* Not a card: the board is the page's own surface, as Ocean's preview draws it. */}
      <div className="stack">
        {v.board.sprintsEnabled && !v.sprint ? <p className="note">{t('page.board.thisBoardHasNoSprint')}</p> : null}
        {total === 0 ? <p className="note">{v.sprint ? t('page.board.nothingIsInYet', { name: v.sprint.name }) : t('page.board.thereAreNoIssuesOn')}</p> : null}
        {v.swimlanes.length ? <LaneOrder board={v.board} /> : null}
        <Board view={v} onCommand={askFor} />
      </div>
      <CommandBar issues={ask?.issues ?? []} open={ask !== null} initial={ask?.initial} onClose={closeAsk} />
    </>
  );
}

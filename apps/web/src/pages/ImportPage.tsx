import type { Import, ImportCheck, ImportCredentials, ImportUndo } from '@a4a/shared';
import { useQueryClient } from '@tanstack/react-query';
import { useId, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { useLinkTypes, useProjectFields, useProjects } from '../api/queries';
import { Badge } from '../components/Badges';
import { Icon } from '../components/Icon';
import { ErrorNote, Loading, PageHead } from '../components/States';
import { Said, errorText } from '../features/common/bits';
import { Confirm } from '../features/common/Confirm';
import {
  checkImport,
  continueFetch,
  heldCredentials,
  holdCredentials,
  importKeys,
  putMapping,
  runImport,
  undoImport,
  uploadFile,
  useImport,
  useImportRows,
  useImports,
} from '../features/imports/api';
import { FromApiForm, OriginSummary, SOURCE_NAME, TokenFields } from '../features/imports/FromApi';
import { ColumnsTable, ProblemsTable, Tally, ValuesTable, whereFrom } from '../features/imports/MappingTable';
import { whenRead } from '../features/common/format';
import { t, tr } from '../i18n';

const SOURCES: Record<Import['source'], string> = { jira: 'Jira', youtrack: 'YouTrack', csv: t('page.import.aCsvFile'), github: t('page.import.githubIssues'), redmine: 'Redmine', zendesk: 'Zendesk' };
const FIRST = {
  start: { name: t('page.import.bringTheIssues'), about: t('page.import.jiraSOrYoutrackS') },
  file: { name: t('page.import.uploadTheExport'), about: t('page.import.jiraSOrYoutrackS2') },
  api: { name: t('page.import.readTheIssues'), about: t('page.import.fromTheOtherTrackerS') },
};
const STAGES = [
  FIRST.file,
  { name: t('page.import.mapIt'), about: t('page.import.itsColumnsToTheProject') },
  { name: t('page.import.checkIt'), about: t('page.import.whatItWouldCreateAnd') },
  { name: t('page.import.importIt'), about: t('page.import.asAJobYouCan') },
  { name: t('page.import.readWhatItDid'), about: t('page.import.whatItMadeWhatIt') },
];

/** Where an import's issues come from, in the list: a file, or a tracker's API. */
const fromWords = (i: Import) => (i.origin ? t('page.import.sApi', { v: SOURCE_NAME[i.origin.kind] }) : SOURCES[i.source]);

/** Ocean's JourneyPath: the stages of an import, each done, now or later. */
function Stages({ now, first = 'file' }: { now: number; first?: keyof typeof FIRST }) {
  return (
    <div className="journey-box">
      <ol className="journey" aria-label={t('page.import.theImportSSteps')}>
        {[FIRST[first], ...STAGES.slice(1)].map((s, i) => {
          const state = i < now ? 'done' : i === now ? 'now' : 'later';
          return (
            <li key={s.name} className={state} aria-current={state === 'now' ? 'step' : undefined}>
              <span className="journey-mark" aria-hidden="true">
                {state === 'done' ? <Icon name="check" /> : i + 1}
              </span>
              <span>
                <strong>{s.name}</strong>
                <span className="hidden">{state === 'done' ? t('page.import.done') : state === 'now' ? t('page.import.toDoNow') : ''}</span>
                <span className="journey-about">{s.about}</span>
              </span>
            </li>
          );
        })}
      </ol>
    </div>
  );
}

function Upload() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  // Importing is managing a project: the ones you manage.
  const projects = (useProjects().data ?? []).filter((p) => !p.archived && p.access.manage);
  const past = useImports();
  const id = useId();
  const [project, setProject] = useState('');
  const [source, setSource] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  return (
    <>
      <Stages now={0} first="start" />
      <section className="card" aria-labelledby={`${id}-h`}>
        <h2 id={`${id}-h`}>{t('page.import.uploadAnExport')}</h2>
        <form
          className="form"
          onSubmit={async (e) => {
            e.preventDefault();
            if (!project) return setProblem(t('page.import.chooseTheProjectToImport'));
            if (!file) return setProblem(t('page.import.chooseTheCsvFileTo'));
            setBusy(true);
            setProblem(null);
            try {
              const imp = await uploadFile(file, project, source || undefined);
              await qc.invalidateQueries({ queryKey: importKeys.list });
              navigate(`/import/${imp.id}`);
            } catch (err) {
              setProblem(errorText(err));
            } finally {
              setBusy(false);
            }
          }}
        >
          <div className="form-fields">
            <div className="form-field">
              <label htmlFor={`${id}-project`}>{t('page.import.intoTheProject')}</label>
              <select id={`${id}-project`} value={project} onChange={(e) => setProject(e.target.value)}>
                <option value="">{t('page.import.chooseAProject')}</option>
                {projects.map((p) => (
                  <option key={p.id} value={p.key}>
                    {p.name}
                  </option>
                ))}
              </select>
            </div>
            <div className="form-field">
              <label htmlFor={`${id}-source`}>{t('page.import.from')}</label>
              <select id={`${id}-source`} value={source} onChange={(e) => setSource(e.target.value)}>
                <option value="">{t('page.import.whicheverWroteItA4aReads')}</option>
                <option value="jira">{t('page.import.jira')}</option>
                <option value="youtrack">{t('page.import.youtrack')}</option>
                <option value="csv">{t('page.import.anotherTracker')}</option>
              </select>
            </div>
          </div>
          <div className="form-field">
            <label htmlFor={`${id}-file`}>{t('page.import.theCsvFile')}</label>
            <input id={`${id}-file`} type="file" accept=".csv,text/csv" aria-describedby={`${id}-file-help`} onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
            <small className="field-help" id={`${id}-file-help`}>{t('page.import.inJiraExportTheIssues')}</small>
          </div>
          {problem ? <Said text={problem} tone="bad" /> : null}
          <div className="cluster end">
            <button type="submit" className="primary" disabled={busy}>
              {busy ? t('page.import.uploading') : t('page.import.uploadIt')}
            </button>
          </div>
        </form>
      </section>
      <FromApiForm />
      {past.data?.length ? (
        <section className="card" aria-labelledby={`${id}-past`}>
          <h2 id={`${id}-past`}>{t('page.import.importsSoFar')}</h2>
          <ul className="directory">
            {past.data.map((i) => (
              <li key={i.id}>
                <span className="directory-name">
                  <Link to={`/import/${i.id}`}>{i.fileName}</Link>
                  <span className="issue-id">{i.project.key}</span>
                </span>
                <p className="note">{tr(i.origin ? 'page.import.fromIssues' : 'page.import.fromRows', { fromWords: fromWords(i), n: i.rows, whenRead: whenRead(i.createdAt), v: i.result ? t('page.import.createdUpdated', { created: i.result.created, updated: i.result.updated }) : '', status: IMPORT_STATUS_WORDS[i.status] ?? i.status })}</p>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </>
  );
}

function Progress({ imp }: { imp: Import }) {
  const { done, total, phase } = imp.progress;
  const pct = total ? Math.min(100, Math.round((done / total) * 100)) : 0;
  const from = imp.origin ? SOURCE_NAME[imp.origin.kind] : '';
  const words =
    phase === 'fetching'
      ? total
        ? t('page.import.readingTheIssuesFromOf', { from: from, done: done, total: total })
        : t('page.import.readingTheIssuesFromSo', { from: from, done: done })
      : phase === 'links'
        ? t('page.import.linkingOfIssues', { done: done, n: total })
        : t(imp.origin ? 'page.import.importingOfIssues' : 'page.import.importingOfRows', { done: done, n: total });
  return (
    <div className="import-progress" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct} aria-valuetext={words} aria-label={t('page.import.howFarTheImportIs')}>
      <svg aria-hidden="true">
        <rect className="import-progress-track" width="100%" height="100%" rx="3" />
        <rect className="import-progress-done" width={`${pct}%`} height="100%" rx="3" />
      </svg>
      <p>{tr('page.import.youCanLeaveThisPage', { words: words })}</p>
    </div>
  );
}

function Report({ imp }: { imp: Import }) {
  const qc = useQueryClient();
  const problems = useImportRows(imp.id, 'problems', true);
  const created = useImportRows(imp.id, 'created', true);
  const [undo, setUndo] = useState<ImportUndo | null>(null);
  const [said, setSaid] = useState<{ text: string; tone?: 'bad' } | null>(null);
  const r = imp.result!;
  const rows = problems.data?.items ?? [];
  return (
    <>
      <section className="card stack" aria-label={t('page.import.whatTheImportDid')}>
        <div className="section-head">
          <h2>{t('page.import.whatItDid')}</h2>
          {imp.status === 'undone' ? <Badge tone="idle">{t('page.import.undone')}</Badge> : <Badge tone="good">{t('page.import.done2')}</Badge>}
        </div>
        <Tally counts={r} label={t('page.import.whatItDid')} />
        {r.linksMissing ? (
          <p className="note">{tr(imp.origin ? 'page.import.linksNamedIssuesNotRead' : 'page.import.linksNamedIssuesNotInFile', { n: r.linksMissing })}</p>
        ) : null}
        {created.data?.items.length ? (
          <p className="note">{tr('page.import.itMade', { map: created.data.items.slice(0, 12).map((row, i) => (
              <span key={row.row}>
                {i ? ', ' : ''}
                <Link className="issue-id" to={`/issues/${row.issue}`}>
                  {row.issue}
                </Link>
              </span>
            )), v: created.data.total > 12 ? t('page.import.andMore', { v: created.data.total - 12 }) : '' })}</p>
        ) : null}
      </section>
      {rows.length ? (
        <section className="card stack" aria-label={t('page.import.rowsWithProblems')}>
          <h2>{tr('page.import.countRowsWithProblems', { n: problems.data!.total })}</h2>
          <ProblemsTable problems={rows.flatMap((row) => row.problems)} caption={t('page.import.problemsRowByRow')} />
        </section>
      ) : null}
      <section className="card stack" aria-label={t('page.import.undo')}>
        <h2>{t('page.import.undoIt')}</h2>
        <p className="note">{t('page.import.undoingTakesAwayTheIssues')}</p>
        <Said text={said?.text} tone={said?.tone} />
        {undo && !undo.applied ? (
          <div className="stack">
            <p>
              {undo.remove.length ? t('page.import.issuesWouldGo', { n: undo.remove.length }) : t('page.import.nothingWouldGo')}{' '}
              {undo.keep.length ? t('page.import.issuesWouldStay', { n: undo.keep.length }) : ''}
            </p>
            {undo.keep.length ? (
              <ul>
                {undo.keep.map((k) => (
                  <li key={k.issue}>
                    <Link className="issue-id" to={`/issues/${k.issue}`}>
                      {k.issue}
                    </Link>
                    : {k.why}
                  </li>
                ))}
              </ul>
            ) : null}
            {undo.remove.length ? (
              <Confirm
                label={t('page.import.undoTheImportOfIssues', { n: undo.remove.length })}
                title={t('page.import.deleteTheIssuesThisImportCreated', { n: undo.remove.length })}
                about={t('page.import.theirCommentsLinksAndLogged')}
                confirm={t('page.import.deleteThem')}
                onConfirm={async () => {
                  try {
                    const done = await undoImport(imp.id, false);
                    setUndo(done);
                    setSaid({ text: t('page.import.issuesTakenAway', { n: done.remove.length, v: done.keep.length ? t('page.import.stayed', { length: done.keep.length }) : '' }) });
                    await qc.invalidateQueries({ queryKey: importKeys.all });
                    await qc.invalidateQueries({ queryKey: ['issues'] });
                  } catch (e) {
                    setSaid({ text: errorText(e), tone: 'bad' });
                  }
                }}
              />
            ) : null}
          </div>
        ) : (
          <div className="cluster">
            <button type="button" disabled={imp.status === 'undone'} onClick={async () => setUndo(await undoImport(imp.id, true).catch((e) => (setSaid({ text: errorText(e), tone: 'bad' }), null)))}>{t('page.import.seeWhatUndoingWouldDo')}</button>
          </div>
        )}
      </section>
    </>
  );
}

/** A read from an API that stopped before the end: carry on, with the token again. */
function CarryOn({ imp }: { imp: Import }) {
  const qc = useQueryClient();
  const o = imp.origin!;
  const [credentials, setCredentials] = useState<ImportCredentials>(() => heldCredentials(imp.id) ?? { token: '' });
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  return (
    <section className="card stack" aria-labelledby="carry-on">
      <h2 id="carry-on">{t('page.import.carryOnReading')}</h2>
      <p className="note">{tr('page.import.issuesReadSoFar', { n: o.fetch.issues, v: o.fetch.total ? t('page.import.ofAbout', { total: o.fetch.total }) : '' })}</p>
      <form
        className="form"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setProblem(null);
          try {
            const next = await continueFetch(imp.id, credentials);
            holdCredentials(imp.id, credentials);
            qc.setQueryData(importKeys.one(imp.id), next);
          } catch (err) {
            setProblem(errorText(err));
          } finally {
            setBusy(false);
          }
        }}
      >
        <TokenFields source={o.kind} cloud={o.kind === 'jira' ? o.deployment === 'cloud' : false} credentials={credentials} onChange={setCredentials} />
        {problem ? <Said text={problem} tone="bad" /> : null}
        <div className="cluster end">
          <button type="submit" className="primary" disabled={busy}>
            {busy ? t('page.import.starting') : t('page.import.carryOn')}
          </button>
        </div>
      </form>
    </section>
  );
}

function ImportSteps({ imp }: { imp: Import }) {
  const qc = useQueryClient();
  const fields = useProjectFields(imp.project.key);
  const links = useLinkTypes();
  const phrases = [...new Set((links.data ?? []).flatMap((l) => [l.outward.toLowerCase(), l.inward.toLowerCase()]))];
  const [check, setCheck] = useState<ImportCheck | null>(null);
  const [said, setSaid] = useState<{ text: string; tone?: 'bad' } | null>(null);
  const [busy, setBusy] = useState(false);
  // An import from an API that brings files runs with the token again; this page may hold it already.
  const needsToken = Boolean(imp.origin?.bring.files && imp.origin.fetch.files > 0);
  const [credentials, setCredentials] = useState<ImportCredentials>(() => heldCredentials(imp.id) ?? { token: '' });
  const holding = Boolean(heldCredentials(imp.id));
  const running = imp.status === 'running';
  const reading = imp.status === 'fetching';
  const unread = Boolean(imp.origin && !imp.origin.fetch.complete && !reading);
  const finished = imp.status === 'done' || imp.status === 'undone';
  const stage = reading || unread ? 0 : running ? 3 : finished ? 4 : check ? 3 : 1;

  const change = async (body: Parameters<typeof putMapping>[1]) => {
    try {
      const next = await putMapping(imp.id, body);
      qc.setQueryData(importKeys.one(imp.id), next);
      setCheck(null);
      setSaid({ text: t('page.import.savedCheckItAgainTo') });
    } catch (e) {
      setSaid({ text: errorText(e), tone: 'bad' });
    }
  };

  return (
    <>
      <Stages now={stage} first={imp.origin ? 'api' : 'file'} />
      <Said text={said?.text} tone={said?.tone} />
      {imp.status === 'stopped' ? (
        <p className="error-note" role="alert">
          <Icon name="cross" />
          <strong>{unread ? t('page.import.readingTheIssuesStoppedBefore') : t('page.import.theImportStoppedBeforeIt')}</strong>
        </p>
      ) : null}
      {imp.error ? <ErrorNote error={new Error(imp.error)} /> : null}
      {reading ? (
        <section className="card stack" aria-label={t('page.import.readingTheIssues')}>
          <h2>{tr('page.import.readingTheIssuesFor', { name: imp.project.name })}</h2>
          <OriginSummary imp={imp} />
          <Progress imp={imp} />
        </section>
      ) : null}
      {unread ? <CarryOn imp={imp} /> : null}
      {running ? (
        <section className="card stack" aria-label={t('page.import.importing')}>
          <h2>{tr('page.import.importingInto', { name: imp.project.name })}</h2>
          <Progress imp={imp} />
        </section>
      ) : null}
      {finished && imp.result ? <Report imp={imp} /> : null}
      {!running && !finished && !reading && !unread ? (
        <>
          <section className="card stack" aria-labelledby="map-columns">
            <div className="section-head">
              <h2 id="map-columns">{t('page.import.itsColumns')}</h2>
              {imp.origin ? (
                <OriginSummary imp={imp} />
              ) : (
                <p className="note">{tr('page.import.fileRowsColumns', { fileName: imp.fileName, v: SOURCES[imp.source], rows: imp.rows, columns: imp.columns.length })}</p>
              )}
            </div>
            {fields.data ? <ColumnsTable imp={imp} fields={fields.data} phrases={phrases} onTarget={(i, t) => change({ columns: { [String(i)]: t } })} /> : <Loading what="loadingLine.projectFields" />}
          </section>
          {imp.values.map((map) => (
            <section key={map.target} className="card stack" aria-labelledby={`values-${map.target}`}>
              <div className="section-head">
                <h2 id={`values-${map.target}`}>{map.label}</h2>
                <p className="note">{tr('page.import.whatEachInBecomesHere', { v: map.label === 'Sprint' ? 'sprint' : 'value', whereFrom: whereFrom(imp) })}</p>
              </div>
              <ValuesTable map={map} from={whereFrom(imp)} onValue={(value, to) => change({ values: { [map.target]: { [value]: to } } })} />
            </section>
          ))}
          <section className="card stack" aria-labelledby="check-it">
            <h2 id="check-it">{t('page.import.checkItThenImportIt')}</h2>
            <fieldset className="choice-group column">
              <legend>{t('page.import.anIssueImportedBeforeFound')}</legend>
              {(['update', 'skip'] as const).map((o) => (
                <label key={o} className="choice">
                  <input type="radio" name="onExisting" checked={imp.options.onExisting === o} onChange={() => change({ options: { onExisting: o } })} />{' '}
                  {o === 'update' ? t('page.import.updateWhatChangedInThe') : t('page.import.leaveItAsItIs')}
                </label>
              ))}
            </fieldset>
            <p className="note">{tr('page.import.datesWithoutATimeZone', { timeZone: imp.options.timeZone })}</p>
            {needsToken && !holding ? (
              <div className="stack">
                <p className="note">{tr('page.import.itBringsFiles', { n: imp.origin!.fetch.files, v: SOURCE_NAME[imp.origin!.kind] })}</p>
                <TokenFields source={imp.origin!.kind} cloud={imp.origin!.kind === 'jira' ? imp.origin!.deployment === 'cloud' : false} credentials={credentials} onChange={setCredentials} />
              </div>
            ) : null}
            <div className="cluster">
              <button
                type="button"
                disabled={busy}
                onClick={async () => {
                  setBusy(true);
                  try {
                    setCheck(await checkImport(imp.id));
                    setSaid(null);
                  } catch (e) {
                    setSaid({ text: errorText(e), tone: 'bad' });
                  } finally {
                    setBusy(false);
                  }
                }}
              >{t('page.import.checkIt')}</button>
              {check ? (
                <button
                  type="button"
                  className="primary"
                  disabled={busy || check.counts.created + check.counts.updated === 0 || (needsToken && !holding && !credentials.token.trim())}
                  onClick={async () => {
                    setBusy(true);
                    try {
                      const token = needsToken ? (heldCredentials(imp.id) ?? { ...credentials, token: credentials.token.trim() }) : undefined;
                      const started = await runImport(imp.id, token);
                      if (token) holdCredentials(imp.id, token);
                      qc.setQueryData(importKeys.one(imp.id), started);
                    } catch (e) {
                      setSaid({ text: errorText(e), tone: 'bad' });
                    } finally {
                      setBusy(false);
                    }
                  }}
                >{tr('page.import.importIssues', { n: check.counts.created + check.counts.updated })}</button>
              ) : null}
            </div>
            {check ? (
              <div className="stack" aria-live="polite">
                <Tally counts={check.counts} label={t('page.import.whatItWouldDo')} planned />
                {check.warnings.length ? (
                  <ul className="note">
                    {check.warnings.map((w) => (
                      <li key={w}>{w}</li>
                    ))}
                  </ul>
                ) : null}
                <ProblemsTable problems={check.problems} caption={t('page.import.problemsRowByRow')} />
                {check.counts.problems > check.problems.length ? <p className="note">{tr('page.import.theFirstProblems', { length: check.problems.length, n: check.counts.problems })}</p> : null}
              </div>
            ) : null}
          </section>
        </>
      ) : null}
    </>
  );
}

/** What an import is doing, in words (D49): its status is a code. */
const IMPORT_STATUS_WORDS: Record<string, string> = {
  fetching: t('page.import.statusFetching'),
  ready: t('page.import.statusReady'),
  running: t('page.import.statusRunning'),
  stopped: t('page.import.statusStopped'),
  done: t('page.import.statusDone'),
  failed: t('page.import.statusFailed'),
  undone: t('page.import.statusUndone'),
};

export default function ImportPage() {
  const { id } = useParams();
  const imp = useImport(id);
  return (
    <ManagersOnly>
      <PageHead
        title={t('page.import.import2')}
        crumbs={
          id ? (
            <>
              <Link to="/import">{t('page.import.import2')}</Link>
              <span className="sep" aria-hidden="true">
                /
              </span>
            </>
          ) : undefined
        }
        about={t('page.import.bringIssuesOverFromJira')}
      />
      <div className="stack">
        {!id ? <Upload /> : null}
        {id && imp.isLoading ? <Loading what="loadingLine.import" /> : null}
        {id && imp.error ? <ErrorNote error={imp.error} /> : null}
        {imp.data ? <ImportSteps imp={imp.data} /> : null}
      </div>
    </ManagersOnly>
  );
}

/** For someone who manages a project; others are told who can import. */
function ManagersOnly({ children }: { children: React.ReactNode }) {
  const projects = useProjects();
  if (projects.data && !projects.data.some((p) => p.access.manage)) {
    return <PageHead title={t('page.import.import2')} about={t('page.import.importingIsForAProject')} />;
  }
  return <>{children}</>;
}

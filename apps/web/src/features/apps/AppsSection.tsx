/**
 * Apps, for administrators (D48): what's installed, what each may do and where it runs, its
 * settings and run log; installing from a package or a catalog after reading what it asks for;
 * updating, asking again only for more; and removing, after saying what goes.
 */
import type { App, AppPackagePreview, AppPermissions, AppRemoval, AppRun, AppSettingDef, AppSettings, CatalogApp, CatalogList } from '@a4a/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useId, useState } from 'react';
import { del, get, patch, post, put } from '../../api/client';
import { useProjects } from '../../api/queries';
import { ago } from '../../components/Badges';
import { ErrorNote, Loading } from '../../components/States';
import { errorText, FormField, Said } from '../common/bits';
import { Confirm } from '../common/Confirm';
import { appKeys, base64Of } from './api';
import { t, tr } from '../../i18n';
import type { ReactNode } from 'react';

const EXTENSION_WORDS: Record<string, string> = {
  'issue-panel': t('apps.appsSection.anIssueSSidePanel'),
  'issue-below-summary': t('apps.appsSection.belowAnIssueSSummary'),
  'project-settings': t('apps.appsSection.aProjectSPage'),
  'main-menu': t('apps.appsSection.aPageOfItsOwn'),
  dashboard: 'dashboards',
  'article-panel': t('apps.appsSection.anArticleSSide'),
};

type Source = { kind: 'upload'; package: string } | { kind: 'catalog'; catalog: string; name: string; version: string };

/** What an app asks for and adds, as the person deciding reads it. */
function Asks({ p }: { p: AppPackagePreview }) {
  const more = p.more && (p.more.read.length || p.more.write.length) ? p.more : null;
  return (
    <div className="stack tight">
      <div className="app-card-head">
        <div>
          <h3>
            {p.title} <span className="note">{p.version}{p.vendor ? ` · ${p.vendor}` : ''}</span>
          </h3>
          {p.description ? <p className="note">{p.description}</p> : null}
        </div>
      </div>
      <p className="label">{p.installed ? t('apps.appsSection.itSInstalledAtThis', { version: p.installed.version }) : t('apps.appsSection.itAsksTo')}</p>
      {p.words.length ? (
        <ul className="app-may" aria-label={t('apps.appsSection.whatItAsksToDo')}>
          {p.words.map((w) => (
            <li key={w}>{w}</li>
          ))}
        </ul>
      ) : (
        <p className="note">{t('apps.appsSection.nothingOfA4aSIt')}</p>
      )}
      {more ? <p className="approval-note">{tr('apps.appsSection.itAsksForMoreThan', { join: [...more.read.map((r) => t('apps.appsSection.reading', { r: r })), ...more.write.map((r) => t('apps.appsSection.writing', { r: r }))].join(', ') })}</p> : null}
      <p className="note">{tr('apps.appsSection.itAddsFilesKbSha', { join: [
          ...p.widgets.map((w) => t('apps.appsSection.on', { title: w.title, v: EXTENSION_WORDS[w.at] ?? w.at })),
          ...p.handlers.map((h) => t('apps.appsSection.aHandler', { title: h.title })),
          ...p.rules.map((r) => t('apps.appsSection.aRuleActingAsIts', { title: r.title })),
        ].join('; '), v: p.signedBy ? t('apps.appsSection.signedByTheTrustedKey', { signedBy: p.signedBy }) : t('apps.appsSection.notSigned'), files: p.files, toFixed: (p.bytes / 1024).toFixed(0), slice: p.sha256.slice(0, 12), t0: (c: ReactNode) => <span className="mono">{c}</span> })}</p>
    </div>
  );
}

/** Where it runs: every project, or the ones chosen. */
function WhereFields({ every, setEvery, chosen, setChosen }: { every: boolean; setEvery: (v: boolean) => void; chosen: Set<string>; setChosen: (v: Set<string>) => void }) {
  const projects = useProjects();
  const id = useId();
  return (
    <div className="stack tight" role="group" aria-labelledby={id}>
      <p className="label" id={id}>{t('apps.appsSection.whereItRuns')}</p>
      <label className="approval-pick">{tr('apps.appsSection.everyProjectThoseMadeLater', { el: <input type="checkbox" checked={every} onChange={(e) => setEvery(e.target.checked)} /> })}</label>
      {!every
        ? (projects.data ?? []).map((p) => (
            <label key={p.key} className="approval-pick">
              <input
                type="checkbox"
                checked={chosen.has(p.key)}
                onChange={(e) => {
                  const next = new Set(chosen);
                  if (e.target.checked) next.add(p.key);
                  else next.delete(p.key);
                  setChosen(next);
                }}
              />{' '}
              <span className="mono">{p.key}</span> {p.name}
            </label>
          ))
        : null}
    </div>
  );
}

/** Deciding on a package: what it asks, where it runs, and installing or updating it. */
function Decide({ preview, source, onDone, onCancel }: { preview: AppPackagePreview; source: Source; onDone: (said: string) => void; onCancel: () => void }) {
  const qc = useQueryClient();
  const [every, setEvery] = useState(false);
  const [chosen, setChosen] = useState<Set<string>>(new Set());
  const [said, setSaid] = useState<string | null>(null);
  const updating = Boolean(preview.installed);
  const accept: AppPermissions = preview.asks;
  const go = useMutation({
    mutationFn: async () => {
      const where = { allProjects: every, projects: every ? undefined : [...chosen] };
      if (source.kind === 'upload') {
        return updating ? put<App>(`/apps/${preview.name}/package`, { package: source.package, accept }) : post<App>('/apps', { package: source.package, accept, ...where });
      }
      return post<App>('/apps/catalog/install', { catalog: source.catalog, name: source.name, version: source.version, accept, ...(updating ? {} : where) });
    },
    onSuccess: (app) => {
      void qc.invalidateQueries({ queryKey: appKeys.all });
      onDone(updating ? t('apps.appsSection.isUpdatedTo', { title: app.title, version: app.version }) : t('apps.appsSection.isInstalled', { title: app.title, v: app.allProjects ? t('apps.appsSection.forEveryProject') : app.projects.length ? t('apps.appsSection.for2', { join: app.projects.map((p) => p.key).join(', ') }) : t('apps.appsSection.chooseWhereItRuns') }));
    },
    onError: (e) => setSaid(errorText(e)),
  });
  return (
    <section className="card stack" aria-label={t('apps.appsSection.install', { title: preview.title })}>
      <Asks p={preview} />
      {!updating ? <WhereFields every={every} setEvery={setEvery} chosen={chosen} setChosen={setChosen} /> : null}
      <Said text={said} tone="bad" />
      <div className="cluster">
        <button type="button" className="primary" onClick={() => go.mutate()} disabled={go.isPending}>
          {go.isPending ? t('apps.appsSection.installing') : updating ? t('apps.appsSection.updateTo', { version: preview.version }) : t('apps.appsSection.installIt')}
        </button>
        <button type="button" onClick={onCancel}>{t('apps.appsSection.donT')}</button>
      </div>
    </section>
  );
}

function useSettingsForm({ app, project }: { app: string; project: string | null }) {
  const qc = useQueryClient();
  const settings = useQuery({ queryKey: appKeys.settings(app, project), queryFn: () => get<AppSettings>(`/apps/${app}/settings${project ? `?project=${encodeURIComponent(project)}` : ''}`) });
  const [said, setSaid] = useState<{ text: string; bad?: boolean } | null>(null);
  const save = useMutation({
    mutationFn: (values: Record<string, string | number | boolean | null>) => put<AppSettings>(`/apps/${app}/settings`, { project, values }),
    onSuccess: () => {
      setSaid({ text: t('apps.appsSection.saved') });
      void qc.invalidateQueries({ queryKey: appKeys.settings(app, project) });
    },
    onError: (e) => setSaid({ text: errorText(e), bad: true }),
  });
  return { settings, save, said };
}

function Settings({ defs, app, project }: { defs: AppSettingDef[]; app: string; project: string | null }) {
  const { settings, save, said } = useSettingsForm({ app, project });
  const [draft, setDraft] = useState<Record<string, string | boolean>>({});
  if (!defs.length) return null;
  const valueOf = (d: AppSettingDef): string | boolean => {
    if (d.name in draft) return draft[d.name]!;
    const v = settings.data?.values[d.name];
    if (d.type === 'secret') return '';
    if (d.type === 'boolean') return Boolean(v);
    return v === null || v === undefined ? '' : String(v);
  };
  return (
    <form
      className="form-fields"
      aria-label={t('apps.appsSection.itsSettings')}
      onSubmit={(e) => {
        e.preventDefault();
        const values: Record<string, string | number | boolean | null> = {};
        for (const d of defs) {
          if (!(d.name in draft)) continue;
          const v = draft[d.name]!;
          values[d.name] = d.type === 'number' ? (v === '' ? null : Number(v)) : v;
        }
        save.mutate(values);
        setDraft({});
      }}
    >
      {settings.isLoading ? <Loading what="loadingLine.appSettings" /> : null}
      {defs.map((d) => {
        const secretSet = d.type === 'secret' && (settings.data?.values[d.name] as { set?: boolean } | undefined)?.set;
        return (
          <FormField key={d.name} label={d.title} help={d.type === 'secret' ? `${d.description ?? ''} ${secretSet ? t('apps.appsSection.itSSetA4aNever') : t('apps.appsSection.notSet')}`.trim() : (d.description ?? undefined)}>
            {(id, help) =>
              d.type === 'boolean' ? (
                <input id={id} aria-describedby={help} type="checkbox" checked={Boolean(valueOf(d))} onChange={(e) => setDraft({ ...draft, [d.name]: e.target.checked })} />
              ) : d.type === 'choice' ? (
                <select id={id} aria-describedby={help} value={String(valueOf(d))} onChange={(e) => setDraft({ ...draft, [d.name]: e.target.value })}>
                  {(d.choices ?? []).map((c) => (
                    <option key={c}>{c}</option>
                  ))}
                </select>
              ) : (
                <input
                  id={id}
                  aria-describedby={help}
                  type={d.type === 'secret' ? 'password' : d.type === 'number' ? 'number' : 'text'}
                  autoComplete="off"
                  value={String(valueOf(d))}
                  placeholder={d.type === 'secret' && secretSet ? '••••••••' : d.default !== null ? String(d.default) : ''}
                  onChange={(e) => setDraft({ ...draft, [d.name]: e.target.value })}
                />
              )
            }
          </FormField>
        );
      })}
      <div className="cluster tw:col-span-full">
        <button type="submit" disabled={save.isPending || !Object.keys(draft).length}>{t('apps.appsSection.saveItsSettings')}</button>
        <Said text={said?.text} tone={said?.bad ? 'bad' : undefined} />
      </div>
    </form>
  );
}

function Runs({ app }: { app: string }) {
  const runs = useQuery({ queryKey: appKeys.runs(app), queryFn: () => get<AppRun[]>(`/apps/${app}/runs`) });
  if (runs.isLoading) return <Loading what="loadingLine.appRuns" />;
  if (runs.error) return <ErrorNote error={runs.error} />;
  if (!runs.data?.length) return <p className="note">{t('apps.appsSection.itsHandlersAndRulesHaven')}</p>;
  return (
    <table className="figures" aria-label={t('apps.appsSection.whatItDid')}>
      <thead>
        <tr>
          <th scope="col">{t('apps.appsSection.when')}</th>
          <th scope="col">{t('apps.appsSection.what')}</th>
          <th scope="col">{t('apps.appsSection.issue')}</th>
          <th scope="col">{t('apps.appsSection.howItWent')}</th>
        </tr>
      </thead>
      <tbody>
        {runs.data.slice(0, 20).map((r) => (
          <tr key={r.id}>
            <td>{ago(r.at)}</td>
            <td>
              {r.kind === 'handler' ? t('apps.appsSection.handler') : t('apps.appsSection.rule')} {r.name}
              {r.by ? <span className="note">{tr('apps.appsSection.for', { name: r.by.name })}</span> : null}
            </td>
            <td className="mono">{r.issue ?? '—'}</td>
            <td>
              {r.outcome}
              {r.message ? <span className="note"> · {r.message.slice(0, 140)}</span> : null}
              {r.ms !== null ? <span className="note">{tr('apps.appsSection.ms', { ms: r.ms })}</span> : null}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function InstalledApp({ app }: { app: App }) {
  const qc = useQueryClient();
  const [open, setOpen] = useState<'where' | 'settings' | 'runs' | null>(null);
  const [every, setEvery] = useState(app.allProjects);
  const [chosen, setChosen] = useState<Set<string>>(new Set(app.projects.filter((p) => !p.off || app.allProjects).map((p) => p.key)));
  const [said, setSaid] = useState<{ text: string; bad?: boolean } | null>(null);
  const titleId = useId();
  const change = useMutation({
    mutationFn: (body: { enabled?: boolean; allProjects?: boolean; projects?: string[] }) => patch<App>(`/apps/${app.name}`, body),
    onSuccess: (a) => {
      setSaid({ text: a.enabled ? t('apps.appsSection.saved') : t('apps.appsSection.isOffNoneOfIt', { title: a.title }) });
      void qc.invalidateQueries({ queryKey: appKeys.all });
    },
    onError: (e) => setSaid({ text: errorText(e), bad: true }),
  });
  const removal = useQuery({ queryKey: ['app-removal', app.name], queryFn: () => get<AppRemoval>(`/apps/${app.name}/removal`), enabled: false });
  const remove = async () => {
    try {
      await del(`/apps/${app.name}`);
      void qc.invalidateQueries({ queryKey: appKeys.all });
    } catch (e) {
      setSaid({ text: errorText(e), bad: true });
    }
  };
  const where = app.allProjects ? t('apps.appsSection.everyProject') : app.projects.filter((p) => p.enabled).map((p) => p.key).join(', ') || t('apps.appsSection.noProjectYet');
  const r = removal.data;
  return (
    <li className="card app-card" aria-labelledby={titleId}>
      <div className="app-card-head">
        <span className="app-icon" aria-hidden="true">
          {app.iconUrl ? <img src={app.iconUrl} alt="" /> : null}
        </span>
        <div>
          <h3 id={titleId}>
            {app.title} <span className="note">{app.version}{app.vendor ? ` · ${app.vendor}` : ''}</span>
          </h3>
          {app.description ? <p className="note">{app.description}</p> : null}
        </div>
      </div>
      <p className="label">{t('apps.appsSection.itMay')}</p>
      <ul className="app-may">
        {app.words.map((w) => (
          <li key={w}>{w}</li>
        ))}
      </ul>
      <p className="note">{tr('apps.appsSection.itsRulesActAsInstalled', { v: app.enabled ? t('apps.appsSection.runsIn', { where: where }) : t('apps.appsSection.offNoneOfItRuns'), login: app.agent.login, when: ago(app.installedAt), v2: app.installedBy ? t('apps.appsSection.by', { name: app.installedBy.name }) : '', v3: app.source.kind === 'catalog' ? t('apps.appsSection.fromACatalog') : '' })}</p>
      <div className="cluster">
        <button type="button" className="small" onClick={() => change.mutate({ enabled: !app.enabled })} disabled={change.isPending}>
          {app.enabled ? t('apps.appsSection.turnItOff') : t('apps.appsSection.turnItOn')}
        </button>
        <button type="button" className="small" aria-expanded={open === 'where'} onClick={() => setOpen(open === 'where' ? null : 'where')}>{t('apps.appsSection.whereItRuns')}</button>
        {app.settings.some((s) => s.scope === 'app') ? (
          <button type="button" className="small" aria-expanded={open === 'settings'} onClick={() => setOpen(open === 'settings' ? null : 'settings')}>{t('apps.appsSection.settings')}</button>
        ) : null}
        <button type="button" className="small" aria-expanded={open === 'runs'} onClick={() => setOpen(open === 'runs' ? null : 'runs')}>{t('apps.appsSection.whatItDid')}</button>
        <span onFocusCapture={() => !removal.data && void removal.refetch()} onMouseEnter={() => !removal.data && void removal.refetch()}>
          <Confirm
            small
            label={t('apps.appsSection.removeIt')}
            name={t('apps.appsSection.remove2', { title: app.title })}
            title={t('apps.appsSection.remove', { title: app.title })}
            about={
              r
                ? t('apps.appsSection.itsPartsGoWithSettings', { rules: r.rules, widgets: r.widgets, handlers: r.handlers, settings: r.settings, stored: r.stored, runs: r.runs, agent: r.agent })
                : t('apps.appsSection.itsRulesWidgetsHandlersSettings')
            }
            confirm={t('apps.appsSection.removeIt')}
            onConfirm={() => void remove()}
          />
        </span>
      </div>
      {open === 'where' ? (
        <form
          className="stack tight"
          onSubmit={(e) => {
            e.preventDefault();
            change.mutate({ allProjects: every, projects: [...chosen] });
          }}
        >
          <WhereFields every={every} setEvery={setEvery} chosen={chosen} setChosen={setChosen} />
          {app.projects.some((p) => p.off) ? <p className="note">{tr('apps.appsSection.turnedOffByTheirManagers', { join: app.projects.filter((p) => p.off).map((p) => p.key).join(', ') })}</p> : null}
          <div className="cluster">
            <button type="submit" className="small primary" disabled={change.isPending}>{t('apps.appsSection.saveWhereItRuns')}</button>
          </div>
        </form>
      ) : null}
      {open === 'settings' ? <Settings defs={app.settings.filter((s) => s.scope === 'app')} app={app.name} project={null} /> : null}
      {open === 'runs' ? <Runs app={app.name} /> : null}
      <Said text={said?.text} tone={said?.bad ? 'bad' : undefined} />
    </li>
  );
}

function Catalog({ onPick }: { onPick: (a: CatalogApp) => void }) {
  const catalog = useQuery({ queryKey: appKeys.catalog, queryFn: () => get<CatalogList>('/apps/catalog'), staleTime: 60_000 });
  if (catalog.isLoading) return <Loading what="loadingLine.catalogs" />;
  if (catalog.error) return <ErrorNote error={catalog.error} />;
  const c = catalog.data!;
  return (
    <div className="stack tight">
      {c.problems.map((p) => (
        <p key={p.catalog} className="error-line" role="alert">
          {p.message}
        </p>
      ))}
      {c.apps.length ? (
        <table className="figures" aria-label={t('apps.appsSection.appsInTheCatalogs')}>
          <thead>
            <tr>
              <th scope="col">{t('apps.appsSection.app')}</th>
              <th scope="col">{t('apps.appsSection.version')}</th>
              <th scope="col">{t('apps.appsSection.from')}</th>
              <th scope="col" className="fit">
                <span className="hidden">{t('apps.appsSection.install2')}</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {c.apps.map((a) => (
              <tr key={`${a.catalog}/${a.name}`}>
                <td>
                  <strong>{a.title}</strong>
                  {a.description ? <span className="note"> · {a.description}</span> : null}
                </td>
                <td>
                  {a.version}
                  {a.installed ? <span className="note">{tr('apps.appsSection.installed', { installed: a.installed })}</span> : null}
                </td>
                <td>
                  {a.catalogName}
                  {a.signed ? <span className="note">{t('apps.appsSection.signed')}</span> : null}
                </td>
                <td className="fit">
                  {!a.installed || a.update ? (
                    <button type="button" className="small" onClick={() => onPick(a)} aria-label={`${a.update ? t('apps.appsSection.update') : t('apps.appsSection.install2')} ${a.title}`}>
                      {a.update ? t('apps.appsSection.update') : t('apps.appsSection.install2')}
                    </button>
                  ) : (
                    <span className="note">{t('apps.appsSection.installed2')}</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <p className="note">{c.problems.length ? t('apps.appsSection.nothingToShowFromThem') : t('apps.appsSection.noCatalogListsAnApp')}</p>
      )}
    </div>
  );
}

/** Apps: installed, and installing. */
export function AppsSection() {
  const apps = useQuery({ queryKey: appKeys.list, queryFn: () => get<App[]>('/apps') });
  const [deciding, setDeciding] = useState<{ preview: AppPackagePreview; source: Source } | null>(null);
  const [said, setSaid] = useState<{ text: string; bad?: boolean } | null>(null);
  const [reading, setReading] = useState(false);
  const [showCatalog, setShowCatalog] = useState(false);
  const fileId = useId();
  const read = async (file: File | undefined) => {
    if (!file) return;
    setSaid(null);
    setReading(true);
    try {
      const pkg = await base64Of(file);
      const preview = await post<AppPackagePreview>('/apps/preview', { package: pkg });
      setDeciding({ preview, source: { kind: 'upload', package: pkg } });
    } catch (e) {
      setSaid({ text: errorText(e), bad: true });
    } finally {
      setReading(false);
    }
  };
  const pick = async (a: CatalogApp) => {
    setSaid(null);
    setReading(true);
    try {
      const preview = await post<AppPackagePreview>('/apps/catalog/preview', { catalog: a.catalog, name: a.name, version: a.version });
      setDeciding({ preview, source: { kind: 'catalog', catalog: a.catalog, name: a.name, version: a.version } });
    } catch (e) {
      setSaid({ text: errorText(e), bad: true });
    } finally {
      setReading(false);
    }
  };
  return (
    <section className="card" aria-labelledby="apps">
      <div className="section-head">
        <h2 id="apps">{t('apps.appsSection.apps')}</h2>
        <span className="note">{t('apps.appsSection.whatAppsAddToA4a')}</span>
      </div>
      <p className="note section-note">{t('apps.appsSection.anAppAddsWidgetsTo')}</p>
      <div className="stack">
        {apps.isLoading ? <Loading what="loadingLine.apps" /> : null}
        {apps.error ? <ErrorNote error={apps.error} /> : null}
        {apps.data?.length ? (
          <ul className="plain stack" aria-label={t('apps.appsSection.installedApps')}>
            {apps.data.map((a) => (
              <InstalledApp key={a.name} app={a} />
            ))}
          </ul>
        ) : apps.data ? (
          <p className="note">{t('apps.appsSection.noAppsAreInstalled')}</p>
        ) : null}
        {deciding ? (
          <Decide
            preview={deciding.preview}
            source={deciding.source}
            onDone={(text) => {
              setDeciding(null);
              setSaid({ text });
            }}
            onCancel={() => setDeciding(null)}
          />
        ) : (
          <div className="cluster">
            <label className="button" htmlFor={fileId}>
              {reading ? t('apps.appsSection.readingIt') : t('apps.appsSection.installFromAFile')}
            </label>
            <input id={fileId} className="hidden" type="file" accept=".zip,application/zip" onChange={(e) => void read(e.target.files?.[0])} />
            <button type="button" aria-expanded={showCatalog} onClick={() => setShowCatalog(!showCatalog)}>{t('apps.appsSection.fromACatalog2')}</button>
          </div>
        )}
        {showCatalog && !deciding ? <Catalog onPick={(a) => void pick(a)} /> : null}
        <Said text={said?.text} tone={said?.bad ? 'bad' : undefined} />
      </div>
    </section>
  );
}

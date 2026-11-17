import type { AppSettings, ProjectApp } from '@a4a/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { get, put } from '../../api/client';
import { ErrorNote, Loading } from '../../components/States';
import { errorText, FormField, Said } from '../common/bits';
import { appKeys } from './api';
import { t } from '../../i18n';

function ProjectSettings({ app, project }: { app: ProjectApp; project: string }) {
  const qc = useQueryClient();
  const settings = useQuery({ queryKey: appKeys.settings(app.name, project), queryFn: () => get<AppSettings>(`/apps/${app.name}/settings?project=${encodeURIComponent(project)}`) });
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [said, setSaid] = useState<{ text: string; bad?: boolean } | null>(null);
  const save = useMutation({
    mutationFn: () => put<AppSettings>(`/apps/${app.name}/settings`, { project, values: Object.fromEntries(Object.entries(draft).map(([k, v]) => [k, v === '' ? null : v])) }),
    onSuccess: () => {
      setDraft({});
      setSaid({ text: t('apps.projectApps.saved') });
      void qc.invalidateQueries({ queryKey: appKeys.settings(app.name, project) });
    },
    onError: (e) => setSaid({ text: errorText(e), bad: true }),
  });
  if (!app.settings.length) return null;
  return (
    <form
      className="form-fields"
      aria-label={t('apps.projectApps.sSettingsFor', { title: app.title, project: project })}
      onSubmit={(e) => {
        e.preventDefault();
        save.mutate();
      }}
    >
      {app.settings.map((d) => (
        <FormField key={d.name} label={d.title} help={d.description ?? undefined}>
          {(id, help) => (
            <input
              id={id}
              aria-describedby={help}
              type={d.type === 'secret' ? 'password' : d.type === 'number' ? 'number' : 'text'}
              autoComplete="off"
              value={draft[d.name] ?? (d.type === 'secret' ? '' : String(settings.data?.values[d.name] ?? ''))}
              onChange={(e) => setDraft({ ...draft, [d.name]: e.target.value })}
            />
          )}
        </FormField>
      ))}
      <div className="cluster tw:col-span-full">
        <button type="submit" className="small" disabled={save.isPending || !Object.keys(draft).length}>{t('apps.projectApps.save')}</button>
        <Said text={said?.text} tone={said?.bad ? 'bad' : undefined} />
      </div>
    </form>
  );
}

/** The apps an administrator chose for a project, which its managers can turn off here (D48). */
export function ProjectApps({ project }: { project: string }) {
  const qc = useQueryClient();
  const apps = useQuery({ queryKey: appKeys.project(project), queryFn: () => get<ProjectApp[]>(`/projects/${project}/apps`) });
  const [said, setSaid] = useState<{ text: string; bad?: boolean } | null>(null);
  const toggle = useMutation({
    mutationFn: (a: ProjectApp) => put<ProjectApp>(`/projects/${project}/apps/${a.name}`, { on: !a.enabled }),
    onSuccess: (a) => {
      setSaid({ text: a.enabled ? t('apps.projectApps.runsInAgain', { title: a.title, project: project }) : t('apps.projectApps.isOffInNoneOf', { title: a.title, project: project }) });
      void qc.invalidateQueries({ queryKey: appKeys.all });
    },
    onError: (e) => setSaid({ text: errorText(e), bad: true }),
  });
  if (apps.isLoading) return <Loading what="loadingLine.projectApps" />;
  if (apps.error) return <ErrorNote error={apps.error} />;
  if (!apps.data?.length) return <p className="note">{t('apps.projectApps.noAppIsChosenFor')}</p>;
  return (
    <div className="stack">
      <ul className="plain stack" aria-label={t('apps.projectApps.appsIn', { project: project })}>
        {apps.data.map((a) => (
          <li key={a.name} className="app-card">
            <div className="cluster spread">
              <span>
                <strong>{a.title}</strong> <span className="note">{a.version} · {a.enabled ? t('apps.projectApps.runsHere') : t('apps.projectApps.offHere')}</span>
              </span>
              <button type="button" className="small" onClick={() => toggle.mutate(a)} disabled={toggle.isPending} aria-label={t('apps.projectApps.in', { v: a.enabled ? t('apps.projectApps.turnOff') : t('apps.projectApps.turnOn'), title: a.title, project: project })}>
                {a.enabled ? t('apps.projectApps.turnItOffHere') : t('apps.projectApps.turnItOnHere')}
              </button>
            </div>
            {a.description ? <p className="note">{a.description}</p> : null}
            <ul className="app-may" aria-label={t('apps.projectApps.whatMayDo', { title: a.title })}>
              {a.words.map((w) => (
                <li key={w}>{w}</li>
              ))}
            </ul>
            {a.enabled ? <ProjectSettings app={a} project={project} /> : null}
          </li>
        ))}
      </ul>
      <Said text={said?.text} tone={said?.bad ? 'bad' : undefined} />
    </div>
  );
}

/**
 * Reading issues from another tracker's API (YouTrack, Jira, GitHub Issues, Redmine, Zendesk, Asana,
 * ClickUp): the form that starts it, the token asked for again
 * (to carry on, or to bring files as it runs), and what an import from an API reads. The token
 * lives in this page's memory and goes only to a4a's server, which uses it and doesn't keep it.
 */
import type { ApiImportSource, Import, ImportCredentials } from '@a4a/shared';
import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useNavigate } from 'react-router';
import { useProjects } from '../../api/queries';
import { errorText, FormField, Said } from '../common/bits';
import { holdCredentials, importFromApi, importKeys } from './api';
import { SOURCE_NAME } from './names';
import { formatBytes } from '../attachments/api';
import { formatList, t, tr } from '../../i18n';
import type { ReactNode } from 'react';

type Source = ApiImportSource;
export { SOURCE_NAME };

/** The order the form offers them in. */
const SOURCES: Source[] = ['youtrack', 'jira', 'github', 'redmine', 'zendesk', 'asana', 'clickup'];

const ADDRESS: Record<Source, string> = {
  youtrack: 'https://example.youtrack.cloud',
  jira: 'https://example.atlassian.net',
  github: 'https://api.github.com',
  redmine: 'https://redmine.example.com',
  zendesk: 'https://example.zendesk.com',
  asana: 'https://app.asana.com',
  clickup: 'https://app.clickup.com',
};

/** Trackers everyone reads at the same address: the form fills it in. */
const ONE_ADDRESS: Partial<Record<Source, string>> = { asana: ADDRESS.asana, clickup: ADDRESS.clickup };

/** What "its work" is called in each tracker that has some; Asana's time isn't read. */
const WORK: Partial<Record<Source, string>> = {
  youtrack: t('imports.fromApi.itsWorkItems'),
  jira: t('imports.fromApi.itsWorklogs'),
  github: t('imports.fromApi.itsWorklogs'),
  redmine: t('imports.fromApi.itsTimeEntries'),
  zendesk: t('imports.fromApi.itsWorklogs'),
  clickup: t('imports.fromApi.itsTimeEntries'),
};

/** Which issues, in each tracker's words: the field's label, its help and an example. */
const WHICH: Record<Source, { label: string; help: string; example: string }> = {
  youtrack: { label: t('imports.fromApi.whichIssuesAQuery'), help: t('imports.fromApi.asYouWouldSearchIn'), example: 'project: BACK' },
  jira: { label: t('imports.fromApi.whichIssuesAJql'), help: t('imports.fromApi.asYouWouldSearchInJira'), example: 'project = BACK' },
  github: { label: t('imports.fromApi.whichIssuesARepository'), help: t('imports.fromApi.ownerNameThenStateOpen'), example: 'acme/backend' },
  redmine: { label: t('imports.fromApi.whichIssuesAProjectS'), help: t('imports.fromApi.asInItsAddressProjects'), example: 'backend' },
  zendesk: { label: t('imports.fromApi.whichTickets'), help: t('imports.fromApi.allOrSince202601'), example: 'all' },
  asana: { label: t('imports.fromApi.whichTasksAProject'), help: t('imports.fromApi.theProjectSAddressIn'), example: 'https://app.asana.com/0/1204567890123456/list' },
  clickup: { label: t('imports.fromApi.whichTasksAList'), help: t('imports.fromApi.theListSAddressIn'), example: 'https://app.clickup.com/9012345678/v/li/901234567890' },
};

/** The token's words for each tracker. */
const TOKEN: Record<Exclude<Source, 'jira'>, { label: string; help: string }> = {
  youtrack: { label: t('imports.fromApi.permanentToken'), help: t('imports.fromApi.inYoutrackYourProfileAccount') },
  github: { label: t('imports.fromApi.token'), help: t('imports.fromApi.aFineGrainedTokenWith') },
  redmine: { label: t('imports.fromApi.apiKey'), help: t('imports.fromApi.inRedmineMyAccountApi') },
  zendesk: { label: t('imports.fromApi.apiToken'), help: t('imports.fromApi.inZendeskAdminCenterApps') },
  asana: { label: t('imports.fromApi.personalAccessToken'), help: t('imports.fromApi.inAsanaMySettingsApps') },
  clickup: { label: t('imports.fromApi.personalToken'), help: t('imports.fromApi.inClickupSettingsApps') },
};

/** The token's fields: a token, and for Jira Cloud the email of its account. */
export function TokenFields({
  source,
  cloud,
  credentials,
  onChange,
}: {
  source: Source;
  /** Jira: whether to ask for the email (Cloud); null to offer it as optional. */
  cloud: boolean | null;
  credentials: ImportCredentials;
  onChange: (c: ImportCredentials) => void;
}) {
  return (
    <div className="form-fields">
      {source === 'zendesk' ? (
        <FormField label={t('imports.fromApi.theAgentSEmail')} help={t('imports.fromApi.theZendeskAgentTheApi')}>
          {(id, help) => (
            <input id={id} type="email" aria-describedby={help} autoComplete="off" value={credentials.email ?? ''} onChange={(e) => onChange({ ...credentials, email: e.target.value || undefined })} />
          )}
        </FormField>
      ) : null}
      {source === 'jira' && cloud !== false ? (
        <FormField
          label={cloud ? t('imports.fromApi.yourAtlassianAccountSEmail') : t('imports.fromApi.emailForJiraCloud')}
          help={cloud ? t('imports.fromApi.theAccountTheApiToken') : t('imports.fromApi.jiraCloudTakesYourAtlassian')}
        >
          {(id, help) => (
            <input
              id={id}
              type="email"
              aria-describedby={help}
              autoComplete="off"
              required={cloud === true}
              value={credentials.email ?? ''}
              onChange={(e) => onChange({ ...credentials, email: e.target.value || undefined })}
            />
          )}
        </FormField>
      ) : null}
      <FormField
        label={source !== 'jira' ? TOKEN[source].label : cloud === false ? t('imports.fromApi.personalAccessToken') : t('imports.fromApi.token')}
        help={
          source !== 'jira'
            ? TOKEN[source].help
            : cloud === false
              ? t('imports.fromApi.inJiraYourProfilePersonal')
              : t('imports.fromApi.jiraCloudAnApiToken')
        }
      >
        {(id, help) => (
          <input id={id} type="password" className="mono" aria-describedby={help} autoComplete="off" required value={credentials.token} onChange={(e) => onChange({ ...credentials, token: e.target.value })} />
        )}
      </FormField>
    </div>
  );
}

/** Start an import from another tracker's API. */
export function FromApiForm() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const projects = (useProjects().data ?? []).filter((p) => !p.archived && p.access.manage);
  const [project, setProject] = useState('');
  const [source, setSource] = useState<Source>('youtrack');
  const [url, setUrl] = useState('');
  const [query, setQuery] = useState('');
  const [credentials, setCredentials] = useState<ImportCredentials>({ token: '' });
  const [bring, setBring] = useState({ comments: true, work: true, files: true });
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  return (
    <section className="card" aria-labelledby="from-api">
      <h2 id="from-api">{t('imports.fromApi.readFromAnotherTracker')}</h2>
      <form
        className="form"
        onSubmit={async (e) => {
          e.preventDefault();
          if (!project) return setProblem(t('imports.fromApi.chooseTheProjectToImport'));
          setBusy(true);
          setProblem(null);
          try {
            const sent = { ...credentials, token: credentials.token.trim(), ...((source === 'jira' || source === 'zendesk') && credentials.email ? { email: credentials.email.trim() } : { email: undefined }) };
            const imp = await importFromApi({ project, source, url: url.trim(), query: query.trim(), credentials: sent, bring: WORK[source] ? bring : { ...bring, work: false } });
            holdCredentials(imp.id, sent);
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
          <FormField label={t('imports.fromApi.intoTheProject')}>
            {(id) => (
              <select id={id} value={project} onChange={(e) => setProject(e.target.value)}>
                <option value="">{t('imports.fromApi.chooseAProject')}</option>
                {projects.map((p) => (
                  <option key={p.id} value={p.key}>
                    {p.name}
                  </option>
                ))}
              </select>
            )}
          </FormField>
          <fieldset className="choice-group">
            <legend>{t('imports.fromApi.from')}</legend>
            {SOURCES.map((s) => (
              <label key={s} className="choice">
                <input
                  type="radio"
                  name="api-source"
                  value={s}
                  checked={source === s}
                  onChange={() => {
                    setSource(s);
                    // Asana and ClickUp have one address for everyone: it's filled in, unless someone wrote their own.
                    if (!url.trim() || Object.values(ONE_ADDRESS).includes(url.trim())) setUrl(ONE_ADDRESS[s] ?? '');
                  }}
                />
                <span>{SOURCE_NAME[s]}</span>
              </label>
            ))}
          </fieldset>
        </div>
        <FormField label={t('imports.fromApi.itsAddress')} help={t('imports.fromApi.whereYouOpenSuchAs', { v: SOURCE_NAME[source], v2: ADDRESS[source] })}>
          {(id, help) => <input id={id} type="url" aria-describedby={help} required placeholder={ADDRESS[source]} value={url} onChange={(e) => setUrl(e.target.value)} />}
        </FormField>
        <TokenFields source={source} cloud={source === 'jira' ? null : false} credentials={credentials} onChange={setCredentials} />
        <FormField label={WHICH[source].label} help={WHICH[source].help}>
          {(id, help) => <input id={id} className="mono" aria-describedby={help} required placeholder={WHICH[source].example} value={query} onChange={(e) => setQuery(e.target.value)} />}
        </FormField>
        <fieldset className="choice-group">
          <legend>{t('imports.fromApi.withEachIssue')}</legend>
          {(
            [
              ['comments', t('imports.fromApi.itsComments')],
              ...(WORK[source] ? ([['work', WORK[source]]] as const) : []),
              ['files', t('imports.fromApi.itsFiles')],
            ] as const
          ).map(([key, label]) => (
            <label key={key} className="choice">
              <input type="checkbox" checked={bring[key]} onChange={(e) => setBring({ ...bring, [key]: e.target.checked })} />
              <span>{label}</span>
            </label>
          ))}
        </fieldset>
        <p className="note">{t('imports.fromApi.a4aUsesTheTokenTo')}</p>
        {problem ? <Said text={problem} tone="bad" /> : null}
        <div className="cluster end">
          <button type="submit" className="primary" disabled={busy}>
            {busy ? t('imports.fromApi.reading') : t('imports.fromApi.readTheIssues')}
          </button>
        </div>
      </form>
    </section>
  );
}

/** What an import from an API reads: where, which issues, as whom, and what came with them. */
export function OriginSummary({ imp }: { imp: Import }) {
  const o = imp.origin!;
  const f = o.fetch;
  const name = SOURCE_NAME[o.kind];
  const brought = [
    o.bring.comments ? t('count.comments', { n: f.comments }) : null,
    o.bring.work && o.kind !== 'asana' ? t(o.kind === 'youtrack' ? 'count.workItems' : o.kind === 'redmine' || o.kind === 'clickup' ? 'count.timeEntries' : 'count.worklogs', { n: f.work }) : null,
    o.bring.files ? (f.files ? t('imports.fromApi.filesOfSize', { n: f.files, size: formatBytes(f.fileBytes) }) : t('count.files', { n: f.files })) : null,
  ].filter((x): x is string => Boolean(x));
  return (
    <p className="note">{tr('imports.fromApi.fromIssuesMatching', { name: name, url: o.url, t0: (c: ReactNode) => <span className="mono">{c}</span>, code: <code>{o.query}</code>, v: o.account ? t('imports.fromApi.readAs', { account: o.account }) : '', n: f.issues, v2: brought.length ? t('imports.fromApi.with', { join: formatList(brought) }) : '', v3: f.left.issues ? t('imports.fromApi.issuesOnlySomeMaySee', { n: f.left.issues }) : '' })}</p>
  );
}

import type { VcsDelivery, VcsDeliveryOutcome, VcsIntegration, VcsIntegrationCreated, VcsProvider, VcsTestResult } from '@a4a/shared';
import { VCS_PROVIDERS, VCS_PROVIDER_NAMES } from '@a4a/shared/constants';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router';
import { del, get, patch, post } from '../api/client';
import { useProjects } from '../api/queries';
import { agoSaid, Badge } from '../components/Badges';
import { ErrorNote, Loading, PageHead } from '../components/States';
import { AdminOnly, errorText, FormField, Said, Scroll } from '../features/common/bits';
import { Confirm } from '../features/common/Confirm';
import { CopyButton } from '../features/common/CopyButton';
import { whenRead } from '../features/common/format';
import { BuildSources } from '../features/builds/Builds';
import { formatList, t, tr } from '../i18n';
import type { ReactNode } from 'react';

const vcsKeys = {
  all: ['vcs', 'integrations'] as const,
  deliveries: (id: string) => ['vcs', 'integrations', id, 'deliveries'] as const,
};
const useIntegrations = () => useQuery({ queryKey: vcsKeys.all, queryFn: () => get<VcsIntegration[]>('/vcs/integrations') });
const useDeliveries = (id: string, enabled: boolean) =>
  useQuery({ queryKey: vcsKeys.deliveries(id), queryFn: () => get<VcsDelivery[]>(`/vcs/integrations/${id}/deliveries`), enabled, refetchInterval: enabled ? 15_000 : false });

const PROVIDER = VCS_PROVIDER_NAMES;
const isBitbucket = (p: VcsProvider) => p === 'bitbucket' || p === 'bitbucket-dc';

/** How a delivery went, with its shape: one that was refused or failed says the status it answered with. */
const OUTCOME: Record<VcsDeliveryOutcome, { tone: 'good' | 'warn' | 'bad' | 'idle'; word: (code: number) => string }> = {
  processed: { tone: 'good', word: () => t('page.integrations.handled') },
  ignored: { tone: 'idle', word: () => t('page.integrations.ignored') },
  duplicate: { tone: 'idle', word: () => t('page.integrations.hadItAlready') },
  received: { tone: 'warn', word: () => t('page.integrations.beingHandled') },
  refused: { tone: 'bad', word: (code) => t('page.integrations.refused', { code }) },
  failed: { tone: 'bad', word: (code) => t('page.integrations.failed', { code }) },
};

const STRONG = (c: ReactNode) => <strong>{c}</strong>;

/** Where to put the URL and secret, in the provider's own words. */
function Steps({ provider }: { provider: VcsProvider }) {
  switch (provider) {
    case 'github':
      return (
        <>
          <p>{t('page.integrations.withTheRepositorySWebhook')}</p>
          <ol>
            <li>{tr('page.integrations.inTheRepositoryOnGithub', { t0: (c: ReactNode) => <strong>{c}</strong>, t1: (c: ReactNode) => <strong>{c}</strong>, t2: (c: ReactNode) => <strong>{c}</strong> })}</li>
            <li>{tr('page.integrations.payloadUrlTheUrlAbove', { code: <code>application/json</code> })}</li>
            <li>{tr('page.integrations.underWhichEventsChooseLet', { t0: (c: ReactNode) => <strong>{c}</strong>, t1: (c: ReactNode) => <strong>{c}</strong>, t2: (c: ReactNode) => <strong>{c}</strong>, t3: (c: ReactNode) => <strong>{c}</strong> })}</li>
          </ol>
          <p>{t('page.integrations.orWithAGithubAppSWebhook')}</p>
          <ol>
            <li>{tr('page.integrations.inTheAppSSettingsUnder', { t0: STRONG, t1: STRONG, t2: STRONG, t3: STRONG })}</li>
            <li>{tr('page.integrations.underPermissionsAndEvents', { t0: STRONG, t1: STRONG, t2: STRONG, t3: STRONG, t4: STRONG, t5: STRONG, t6: STRONG })}</li>
            <li>{tr('page.integrations.generateAPrivateKeyInstall', { t0: STRONG })}</li>
          </ol>
        </>
      );
    case 'gitlab':
      return (
        <ol>
          <li>{tr('page.integrations.inTheProjectOnGitlab', { t0: (c: ReactNode) => <strong>{c}</strong>, t1: (c: ReactNode) => <strong>{c}</strong>, t2: (c: ReactNode) => <strong>{c}</strong> })}</li>
          <li>{t('page.integrations.urlTheUrlAboveSecret')}</li>
          <li>{tr('page.integrations.underTriggerTickPushEvents', { t0: (c: ReactNode) => <strong>{c}</strong>, t1: (c: ReactNode) => <strong>{c}</strong> })}</li>
        </ol>
      );
    case 'bitbucket':
      return (
        <ol>
          <li>{tr('page.integrations.inTheRepositoryOnBitbucket', { t0: (c: ReactNode) => <strong>{c}</strong>, t1: (c: ReactNode) => <strong>{c}</strong>, t2: (c: ReactNode) => <strong>{c}</strong> })}</li>
          <li>{t('page.integrations.urlTheUrlAboveSecret2')}</li>
          <li>{tr('page.integrations.underTriggersChooseFromThe', { t0: (c: ReactNode) => <strong>{c}</strong>, t1: (c: ReactNode) => <strong>{c}</strong>, t2: (c: ReactNode) => <strong>{c}</strong>, t3: (c: ReactNode) => <strong>{c}</strong>, t4: (c: ReactNode) => <strong>{c}</strong> })}</li>
          <li>{t('page.integrations.forPushesOfMoreThan')}</li>
        </ol>
      );
    case 'bitbucket-dc':
      return (
        <ol>
          <li>{tr('page.integrations.inTheRepositoryOpenRepository', { t0: (c: ReactNode) => <strong>{c}</strong>, t1: (c: ReactNode) => <strong>{c}</strong>, t2: (c: ReactNode) => <strong>{c}</strong> })}</li>
          <li>{t('page.integrations.urlTheUrlAboveSecret2')}</li>
          <li>{tr('page.integrations.underEventsTickTheRepository', { t0: (c: ReactNode) => <strong>{c}</strong>, t1: (c: ReactNode) => <strong>{c}</strong>, t2: (c: ReactNode) => <strong>{c}</strong>, t3: (c: ReactNode) => <strong>{c}</strong>, t4: (c: ReactNode) => <strong>{c}</strong> })}</li>
          <li>{tr('page.integrations.bitbucketDataCenterSPushes', { t0: (c: ReactNode) => <strong>{c}</strong> })}</li>
        </ol>
      );
    case 'gitea':
      return (
        <ol>
          <li>{tr('page.integrations.inTheRepositoryOpenSettings', { t0: (c: ReactNode) => <strong>{c}</strong>, t1: (c: ReactNode) => <strong>{c}</strong>, t2: (c: ReactNode) => <strong>{c}</strong>, t3: (c: ReactNode) => <strong>{c}</strong> })}</li>
          <li>{tr('page.integrations.targetUrlTheUrlAbove', { code: <code>POST</code>, code2: <code>application/json</code> })}</li>
          <li>{tr('page.integrations.underTriggerOnChooseCustom', { t0: (c: ReactNode) => <strong>{c}</strong>, t1: (c: ReactNode) => <strong>{c}</strong> })}</li>
          <li>{tr('page.integrations.forBuildsAlsoTick', { t0: (c: ReactNode) => <strong>{c}</strong>, t1: (c: ReactNode) => <strong>{c}</strong>, t2: (c: ReactNode) => <strong>{c}</strong> })}</li>
        </ol>
      );
  }
}

function Deliveries({ integration }: { integration: VcsIntegration }) {
  const deliveries = useDeliveries(integration.id, true);
  if (deliveries.isLoading) return <Loading what="loadingLine.integrationDeliveries" />;
  if (deliveries.error) return <ErrorNote error={deliveries.error} />;
  if (!deliveries.data?.length) return <p className="note">{t('page.integrations.nothingHasComeYetSend')}</p>;
  return (
    <Scroll label={t('page.integrations.tableOfRecentDeliveries')}>
      <table className="figures">
        <thead>
          <tr>
            <th scope="col">{t('page.integrations.when')}</th>
            <th scope="col">{t('page.integrations.event')}</th>
            <th scope="col">{t('page.integrations.howItWent')}</th>
            <th scope="col">{t('page.integrations.whatItDid')}</th>
          </tr>
        </thead>
        <tbody>
          {deliveries.data.map((d) => (
            <tr key={d.id}>
              <td>
                <time dateTime={d.createdAt} title={d.createdAt}>
                  {whenRead(d.createdAt)}
                </time>
              </td>
              <td>
                <span className="mono">{d.event}</span>
                <span className="item-about">{d.test ? t('page.integrations.aTest') : d.deliveryId ? <span className="mono">{d.deliveryId.slice(0, 13)}</span> : null}</span>
              </td>
              <td>
                <Badge tone={OUTCOME[d.outcome].tone}>{OUTCOME[d.outcome].word(d.statusCode)}</Badge>
                {d.linked || d.applied ? (
                  <span className="item-about">{tr('page.integrations.linked', { linked: d.linked, v: d.applied ? t('page.integrations.commandsApplied', { n: d.applied }) : '' })}</span>
                ) : null}
              </td>
              <td>{d.message}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </Scroll>
  );
}

function Secret({ made, onKept }: { made: VcsIntegrationCreated; onKept: () => void }) {
  return (
    <div className="secret" role="status">
      <p>{tr('page.integrations.copyTheSecretNowThis', { t0: (c: ReactNode) => <strong>{c}</strong>, v: PROVIDER[made.provider] })}</p>
      <code>{made.webhookUrl}</code>
      <code>{made.secret}</code>
      <div className="cluster">
        <CopyButton text={made.webhookUrl} label={t('page.integrations.copyTheUrl')} what={t('page.integrations.theUrl')} />
        <CopyButton text={made.secret} label={t('page.integrations.copyTheSecret')} what={t('page.integrations.theSecret')} />
        <button type="button" className="link" onClick={onKept}>{t('page.integrations.iVeKeptIt')}</button>
      </div>
      <Steps provider={made.provider} />
    </div>
  );
}

/** What an access token is for, at each Bitbucket. */
const TOKEN_HELP: Partial<Record<VcsProvider, string>> = {
  github: t('page.integrations.optionalWithATokenThat'),
  bitbucket: t('page.integrations.optionalBitbucketSendsTheLatest'),
  'bitbucket-dc': t('page.integrations.itsPushesNameTheCommits'),
};

/** A Bitbucket integration's access token: given, replaced or taken away. Never shown again. */
function AccessToken({ integration, onSaid }: { integration: VcsIntegration; onSaid: (said: { text: string; bad?: boolean }) => void }) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [token, setToken] = useState('');
  const save = useMutation({
    mutationFn: (accessToken: string | null) => patch<VcsIntegration>(`/vcs/integrations/${integration.id}`, { accessToken }),
    onSuccess: (i) => {
      void qc.invalidateQueries({ queryKey: vcsKeys.all });
      setOpen(false);
      setToken('');
      const github = integration.provider === 'github';
      onSaid({
        text: i.hasAccessToken
          ? github
            ? t('page.integrations.savedA4aAsksGithubWhich')
            : t('page.integrations.savedA4aReadsTheCommits')
          : github
            ? t('page.integrations.theTokenIsGoneA')
            : t('page.integrations.theTokenIsGoneA4a'),
      });
    },
    onError: (e) => onSaid({ text: errorText(e), bad: true }),
  });
  if (!open) {
    return (
      <>
        <button type="button" className="small" onClick={() => setOpen(true)}>
          {integration.hasAccessToken ? t('page.integrations.replaceItsAccessToken') : t('page.integrations.giveItAnAccessToken')}
        </button>
        {integration.hasAccessToken ? (
          <Confirm
            small
            label={t('page.integrations.removeItsAccessToken')}
            title={t('page.integrations.removeSAccessToken', { name: integration.name })}
            about={
              integration.provider === 'bitbucket-dc'
                ? t('page.integrations.withoutItA4aCanT')
                : integration.provider === 'github'
                  ? t('page.integrations.withoutItABuildHolds')
                  : t('page.integrations.withoutItA4aReadsThe')
            }
            confirm={t('page.integrations.removeTheToken')}
            disabled={save.isPending}
            onConfirm={() => save.mutate(null)}
          />
        ) : null}
      </>
    );
  }
  return (
    <form
      className="cluster"
      onSubmit={(e) => {
        e.preventDefault();
        if (token.trim()) save.mutate(token.trim());
      }}
    >
      <FormField label={t('page.integrations.accessToken')} className="inline">
        {(id) => <input id={id} type="password" value={token} onChange={(e) => setToken(e.target.value)} autoComplete="off" required className="mono" />}
      </FormField>
      <button type="submit" className="small primary" disabled={!token.trim() || save.isPending}>{t('page.integrations.saveTheToken')}</button>
      <button type="button" className="small" onClick={() => setOpen(false)}>{t('page.integrations.cancel')}</button>
    </form>
  );
}

/** A GitHub App for a GitHub integration to read as (D54): its id, its private key, and which installation. */
function AppForm({ integration, onSaved, onCancel }: { integration: VcsIntegration; onSaved: (i: VcsIntegration) => void; onCancel: () => void }) {
  const qc = useQueryClient();
  const [appId, setAppId] = useState(integration.githubApp?.appId ?? '');
  const [key, setKey] = useState('');
  const [installation, setInstallation] = useState('');
  const [api, setApi] = useState(integration.baseUrl ?? '');
  const [unread, setUnread] = useState(false);
  const save = useMutation({
    mutationFn: () => {
      const baseUrl = api.trim() || null;
      return patch<VcsIntegration>(`/vcs/integrations/${integration.id}`, {
        githubApp: { appId: appId.trim(), privateKey: key.trim(), ...(installation.trim() ? { installationId: installation.trim() } : {}) },
        ...(baseUrl !== integration.baseUrl ? { baseUrl } : {}),
      });
    },
    onSuccess: (i) => {
      void qc.invalidateQueries({ queryKey: vcsKeys.all });
      setKey('');
      onSaved(i);
    },
  });
  const choose = async (file: File | undefined) => {
    if (!file) return;
    try {
      setKey(await file.text());
      setUnread(false);
    } catch {
      setUnread(true);
    }
  };
  return (
    <form
      className="form"
      aria-label={t('page.integrations.readAsAGithubApp')}
      onSubmit={(e) => {
        e.preventDefault();
        if (appId.trim() && key.trim()) save.mutate();
      }}
    >
      <FormField label={t('page.integrations.appId')} help={t('page.integrations.appIdHelp')}>
        {(id, help) => <input id={id} aria-describedby={help} value={appId} onChange={(e) => setAppId(e.target.value)} required maxLength={64} autoComplete="off" spellCheck={false} className="mono" />}
      </FormField>
      <FormField label={t('page.integrations.privateKey')} help={t('page.integrations.privateKeyHelp')}>
        {(id, help) => <textarea id={id} aria-describedby={help} rows={4} value={key} onChange={(e) => setKey(e.target.value)} required maxLength={10_000} autoComplete="off" spellCheck={false} className="mono" />}
      </FormField>
      <FormField label={t('page.integrations.orChooseThePemFile')}>
        {(id) => <input id={id} type="file" accept=".pem,application/x-pem-file" onChange={(e) => void choose(e.target.files?.[0])} />}
      </FormField>
      {unread ? <Said text={t('page.integrations.thatFileCouldnTBeRead')} tone="bad" /> : null}
      <FormField label={t('page.integrations.installation')} help={t('page.integrations.installationHelp', { name: integration.name })}>
        {(id, help) => <input id={id} aria-describedby={help} value={installation} onChange={(e) => setInstallation(e.target.value)} inputMode="numeric" pattern="[0-9]*" maxLength={20} autoComplete="off" className="mono" />}
      </FormField>
      <FormField label={t('page.integrations.enterpriseApi')} help={t('page.integrations.enterpriseApiHelp')}>
        {(id, help) => <input id={id} aria-describedby={help} type="url" value={api} onChange={(e) => setApi(e.target.value)} placeholder="https://github.acme.example/api/v3" className="mono" />}
      </FormField>
      <div className="cluster">
        <button type="submit" className="small primary" disabled={!appId.trim() || !key.trim() || save.isPending}>
          {save.isPending ? t('page.integrations.checkingWithGithub') : t('page.integrations.saveTheApp')}
        </button>
        <button type="button" className="small" onClick={onCancel}>{t('page.integrations.cancel')}</button>
      </div>
      {save.error ? <ErrorNote error={save.error} /> : null}
    </form>
  );
}

/** How a GitHub integration reads from GitHub: as its GitHub App, with a person's token, or not at all. */
function GithubReads({ integration, onSaid }: { integration: VcsIntegration; onSaid: (said: { text: string; bad?: boolean }) => void }) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const app = integration.githubApp;
  const stop = useMutation({
    mutationFn: () => patch<VcsIntegration>(`/vcs/integrations/${integration.id}`, { githubApp: null }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: vcsKeys.all });
      onSaid({ text: t('page.integrations.a4aNoLongerReadsAsThe') });
    },
    onError: (e) => onSaid({ text: errorText(e), bad: true }),
  });
  const saved = (i: VcsIntegration) => {
    setOpen(false);
    if (i.githubApp) onSaid({ text: t('page.integrations.savedA4aReadsAsThe', { app: i.githubApp.slug ?? i.githubApp.appId, account: i.githubApp.account ?? i.githubApp.installationId }) });
  };
  return (
    <>
      <div className="cluster">
        {app ? (
          <>
            <Badge tone="good">{t('page.integrations.readsAsTheGithubApp', { app: app.slug ?? app.appId, account: app.account ?? app.installationId })}</Badge>
            <button type="button" className="small" aria-expanded={open} onClick={() => setOpen((o) => !o)}>{t('page.integrations.changeTheApp')}</button>
            <Confirm
              small
              label={t('page.integrations.stopReadingAsTheApp')}
              title={t('page.integrations.stopReadingAsTheGithub', { name: integration.name })}
              about={t('page.integrations.a4aForgetsTheAppS')}
              confirm={t('page.integrations.forgetTheApp')}
              disabled={stop.isPending}
              onConfirm={() => stop.mutate()}
            />
          </>
        ) : (
          <>
            {integration.hasAccessToken ? <Badge tone="good">{t('page.integrations.readsBuildsCommitsWithIts')}</Badge> : <Badge tone="idle">{t('page.integrations.noAccessToken')}</Badge>}
            <button type="button" className="small" aria-expanded={open} onClick={() => setOpen((o) => !o)}>{t('page.integrations.readAsAGithubApp')}</button>
            <AccessToken integration={integration} onSaid={onSaid} />
          </>
        )}
      </div>
      {!app && integration.hasAccessToken ? <p className="note">{t('page.integrations.aPersonSTokenStopsWorking')}</p> : null}
      {open ? <AppForm integration={integration} onSaved={saved} onCancel={() => setOpen(false)} /> : null}
    </>
  );
}

function IntegrationCard({ integration, projectNames }: { integration: VcsIntegration; projectNames: Map<string, string> }) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [said, setSaid] = useState<{ text: string; bad?: boolean } | null>(null);
  const [rotated, setRotated] = useState<VcsIntegrationCreated | null>(null);
  const refresh = () => void qc.invalidateQueries({ queryKey: vcsKeys.all });
  const toggle = useMutation({
    mutationFn: (active: boolean) => patch<VcsIntegration>(`/vcs/integrations/${integration.id}`, { active }),
    onSuccess: (i) => {
      refresh();
      setSaid({ text: i.active ? t('page.integrations.itTakesDeliveriesAgain') : t('page.integrations.itIsPausedDeliveriesAre') });
    },
    onError: (e) => setSaid({ text: errorText(e), bad: true }),
  });
  const test = useMutation({
    mutationFn: () => post<VcsTestResult>(`/vcs/integrations/${integration.id}/test`),
    onSuccess: (r) => {
      setOpen(true);
      void qc.invalidateQueries({ queryKey: vcsKeys.deliveries(integration.id) });
      setSaid(r.delivered ? { text: r.message } : { text: r.message || t('page.integrations.theTestDidnTGo'), bad: true });
    },
    onError: (e) => setSaid({ text: errorText(e), bad: true }),
  });
  const rotate = useMutation({
    mutationFn: () => post<VcsIntegrationCreated>(`/vcs/integrations/${integration.id}/secret`),
    onSuccess: (made) => {
      refresh();
      setRotated(made);
      setSaid(null);
    },
    onError: (e) => setSaid({ text: errorText(e), bad: true }),
  });
  const remove = useMutation({
    mutationFn: () => del(`/vcs/integrations/${integration.id}`),
    onSuccess: refresh,
    onError: (e) => setSaid({ text: errorText(e), bad: true }),
  });
  const where = integration.projects.length ? t('page.integrations.issuesOf', { join: formatList(integration.projects.map((k) => projectNames.get(k) ?? k)) }) : t('page.integrations.issuesOfEveryProject');
  const bitbucket = isBitbucket(integration.provider);
  return (
    <li className="card hook">
      <div className="hook-head">
        <div className="hook-what">
          <span className="mono hook-url">{integration.name}</span>
          <span className="item-about">{tr('page.integrations.looksForItsSecretBegins', { v: PROVIDER[integration.provider], where: where, secretPrefix: integration.secretPrefix, t0: (c: ReactNode) => <span className="mono">{c}</span>, when: agoSaid(integration.createdAt), v2: integration.lastDeliveryAt ? t('page.integrations.lastDelivery', { when: agoSaid(integration.lastDeliveryAt) }) : t('page.integrations.nothingHasComeYet') })}</span>
        </div>
        {integration.active ? <Badge tone="good">{t('page.integrations.takesDeliveries')}</Badge> : <Badge tone="idle">{t('page.integrations.paused')}</Badge>}
      </div>
      <div className="cluster">
        <span className="note">{t('page.integrations.webhookUrl')}</span>
        <code className="hook-url">{integration.webhookUrl}</code>
        <CopyButton text={integration.webhookUrl} label={t('page.integrations.copyIt')} what={t('page.integrations.theUrl')} />
      </div>
      {integration.provider === 'github' ? <GithubReads integration={integration} onSaid={setSaid} /> : null}
      {bitbucket ? (
        <div className="cluster">
          {integration.provider === 'bitbucket-dc' && integration.baseUrl ? (
            <span className="note">{tr('page.integrations.readsCommitsAt', { baseUrl: integration.baseUrl, t0: (c: ReactNode) => <span className="mono">{c}</span> })}</span>
          ) : null}
          {integration.hasAccessToken ? (
            <Badge tone="good">{t('page.integrations.readsCommitsWithItsToken')}</Badge>
          ) : (
            <Badge tone={integration.provider === 'bitbucket-dc' ? 'warn' : 'idle'}>{integration.provider === 'bitbucket-dc' ? t('page.integrations.noAccessTokenLinksNo') : t('page.integrations.noAccessToken')}</Badge>
          )}
          <AccessToken integration={integration} onSaid={setSaid} />
        </div>
      ) : null}
      <div className="cluster">
        <button type="button" onClick={() => test.mutate()} disabled={test.isPending}>
          {test.isPending ? t('page.integrations.sending') : t('page.integrations.sendATest')}
        </button>
        <button type="button" onClick={() => toggle.mutate(!integration.active)} disabled={toggle.isPending}>
          {integration.active ? t('page.integrations.pauseIt') : t('page.integrations.turnItBackOn')}
        </button>
        <button type="button" className="link" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
          {open ? t('page.integrations.hideItsDeliveries') : t('page.integrations.showItsDeliveries')}
        </button>
        <span className="grow" />
        <Confirm
          small
          label={t('page.integrations.giveItANewSecret')}
          title={t('page.integrations.giveANewSecret', { name: integration.name })}
          about={t('page.integrations.theOldOneStopsWorking', { v: PROVIDER[integration.provider] })}
          confirm={t('page.integrations.makeANewOne')}
          disabled={rotate.isPending}
          onConfirm={() => rotate.mutate()}
        />
        <Confirm
          small
          label={t('page.integrations.removeIt')}
          title={t('page.integrations.removeTheIntegration', { name: integration.name })}
          about={t('page.integrations.a4aStopsTakingItsDeliveries')}
          confirm={t('page.integrations.removeIt')}
          disabled={remove.isPending}
          onConfirm={() => remove.mutate()}
        />
      </div>
      {rotated ? <Secret made={rotated} onKept={() => setRotated(null)} /> : null}
      <Said text={said?.text} tone={said?.bad ? 'bad' : undefined} />
      {open ? (
        <div className="hook-log">
          <h3>{t('page.integrations.recentDeliveries')}</h3>
          <Deliveries integration={integration} />
        </div>
      ) : null}
    </li>
  );
}

function AddIntegration() {
  const qc = useQueryClient();
  const projects = useProjects();
  const [provider, setProvider] = useState<VcsProvider>('github');
  const [name, setName] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [token, setToken] = useState('');
  const [every, setEvery] = useState(true);
  const [chosen, setChosen] = useState<Set<string>>(() => new Set());
  const [made, setMade] = useState<VcsIntegrationCreated | null>(null);
  const dc = provider === 'bitbucket-dc';
  const add = useMutation({
    mutationFn: () =>
      post<VcsIntegrationCreated>('/vcs/integrations', {
        provider,
        name: name.trim(),
        projects: every ? [] : [...chosen],
        ...(dc ? { baseUrl: baseUrl.trim() } : {}),
        ...(isBitbucket(provider) && token.trim() ? { accessToken: token.trim() } : {}),
      }),
    onSuccess: (i) => {
      setMade(i);
      setName('');
      setBaseUrl('');
      setToken('');
      void qc.invalidateQueries({ queryKey: vcsKeys.all });
    },
  });
  return (
    <section className="card" aria-labelledby="add-vcs">
      <h2 id="add-vcs">{t('page.integrations.addAnIntegration')}</h2>
      <form
        className="form"
        onSubmit={(e) => {
          e.preventDefault();
          add.mutate();
        }}
      >
        <fieldset className="choice-group columns">
          <legend>{t('page.integrations.from')}</legend>
          {VCS_PROVIDERS.map((p) => (
            <label key={p} className="choice">
              <input type="radio" name="provider" value={p} checked={provider === p} onChange={() => setProvider(p)} />
              <span>{PROVIDER[p]}</span>
            </label>
          ))}
        </fieldset>
        <FormField label={t('page.integrations.name')} help={t('page.integrations.usuallyTheRepositorySoPeople')}>
          {(id, help) => (
            <input
              id={id}
              aria-describedby={help}
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
              maxLength={120}
              placeholder={dc ? t('page.integrations.projBackend') : 'acme/backend'}
              className="mono"
            />
          )}
        </FormField>
        {dc ? (
          <FormField label={t('page.integrations.bitbucketSAddress')} help={t('page.integrations.wherePeopleOpenItHttps')}>
            {(id, help) => (
              <input
                id={id}
                aria-describedby={help}
                type="url"
                value={baseUrl}
                onChange={(e) => setBaseUrl(e.target.value)}
                required
                placeholder="https://bitbucket.acme.example"
                className="mono"
              />
            )}
          </FormField>
        ) : null}
        {isBitbucket(provider) ? (
          <FormField label={dc ? t('page.integrations.anHttpAccessToken') : t('page.integrations.anAccessTokenIfPushes')} help={TOKEN_HELP[provider]}>
            {(id, help) => <input id={id} aria-describedby={help} type="password" value={token} onChange={(e) => setToken(e.target.value)} autoComplete="off" className="mono" />}
          </FormField>
        ) : null}
        <fieldset className="choice-group columns">
          <legend>{t('page.integrations.issuesItLooksFor')}</legend>
          <label className="choice tw:col-span-full">
            <input type="checkbox" checked={every} onChange={(e) => setEvery(e.target.checked)} />
            <span>{t('page.integrations.ofEveryProjectMembersOnly')}</span>
          </label>
          {!every
            ? (projects.data ?? []).map((p) => (
                <label key={p.key} className="choice">
                  <input
                    type="checkbox"
                    checked={chosen.has(p.key)}
                    onChange={() =>
                      setChosen((s) => {
                        const n = new Set(s);
                        if (n.has(p.key)) n.delete(p.key);
                        else n.add(p.key);
                        return n;
                      })
                    }
                  />
                  <span>
                    {p.name}
                    <small className="field-help mono">{p.key}</small>
                  </span>
                </label>
              ))
            : null}
        </fieldset>
        <div className="cluster">
          <button type="submit" className="primary" disabled={add.isPending || !name.trim() || (dc && !baseUrl.trim()) || (!every && !chosen.size)}>
            {add.isPending ? t('page.integrations.adding') : t('page.integrations.addTheIntegration')}
          </button>
        </div>
        {add.error ? <ErrorNote error={add.error} /> : null}
      </form>
      {made ? <Secret made={made} onKept={() => setMade(null)} /> : null}
    </section>
  );
}

/** Where commits and pull requests come in from version control: each integration, its test, and how each delivery went. */
export default function IntegrationsPage() {
  const integrations = useIntegrations();
  const projects = useProjects();
  const names = new Map((projects.data ?? []).map((p) => [p.key, p.name]));
  return (
    <AdminOnly title={t('page.integrations.integrations')}>
      <PageHead
        title={t('page.integrations.integrations')}
        about={t('page.integrations.githubGitlabBitbucketGiteaAnd')}
      />
      <section className="card" aria-labelledby="vcs-list">
        <h2 id="vcs-list">{t('page.integrations.whereTheyComeFrom')}</h2>
        {integrations.isLoading ? <Loading what="loadingLine.integrations" /> : null}
        {integrations.error ? <ErrorNote error={integrations.error} /> : null}
        {integrations.data && !integrations.data.length ? <p className="note">{t('page.integrations.nowhereYetAddAnIntegration')}</p> : null}
        {integrations.data?.length ? (
          <ul className="hooks">
            {integrations.data.map((i) => (
              <IntegrationCard key={i.id} integration={i} projectNames={names} />
            ))}
          </ul>
        ) : null}
      </section>
      <BuildSources integrations={integrations.data ?? []} />
      <div className="tw:grid tw:grid-cols-[repeat(auto-fit,minmax(min(100%,24rem),1fr))] tw:items-start tw:gap-x-4">
        <AddIntegration />
        <section className="card" aria-labelledby="vcs-how">
          <h2 id="vcs-how">{t('page.integrations.howItWorks')}</h2>
          <dl className="facts-list">
            <div className="pair">
              <dt>{t('page.integrations.linked2')}</dt>
              <dd>{t('page.integrations.aCommitWhoseMessageMentions')}</dd>
            </div>
            <div className="pair">
              <dt>{t('page.integrations.commands')}</dt>
              <dd>{tr('page.integrations.orAppliesWhatFollowsAs', { code: <code>BACK-12 #Fixed</code>, code2: <code>BACK-12 #State Fixed Assignee anna</code>, code3: <code>#</code> })}</dd>
            </div>
            <div className="pair">
              <dt>{t('page.integrations.whoWroteIt')}</dt>
              <dd>{tr('page.integrations.thePersonWhoseConfirmedEmail', { t0: (c: ReactNode) => <Link to="/me">{c}</Link>, t1: (c: ReactNode) => <Link to="/admin">{c}</Link> })}</dd>
            </div>
            <div className="pair">
              <dt>{t('page.integrations.checkedEveryTime')}</dt>
              <dd>{tr('page.integrations.anHmacSha256OfEach', { code: <code>X-Hub-Signature-256</code>, code2: <code>X-Hub-Signature</code>, code3: <code>X-Gitlab-Token</code> })}</dd>
            </div>
            <div className="pair">
              <dt>{t('page.integrations.asAGithubApp')}</dt>
              <dd>{t('page.integrations.aGithubIntegrationCanRead')}</dd>
            </div>
            <div className="pair">
              <dt>{t('page.integrations.bitbucketSCommits')}</dt>
              <dd>{t('page.integrations.bitbucketCloudSendsTheLatest')}</dd>
            </div>
            <div className="pair">
              <dt>{t('page.integrations.once')}</dt>
              <dd>{t('page.integrations.aDeliverySentAgainIs')}</dd>
            </div>
          </dl>
        </section>
      </div>
    </AdminOnly>
  );
}

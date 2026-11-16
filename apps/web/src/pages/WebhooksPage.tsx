import type { Webhook } from '@a4a/shared';
import { EVENT_TYPES } from '@a4a/shared/constants';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { del, patch, post } from '../api/client';
import { keys, useProjects, useWebhooks } from '../api/queries';
import { ago, Badge } from '../components/Badges';
import { ErrorNote, Loading, PageHead } from '../components/States';
import { AdminOnly, errorText, FormField, Said, Scroll } from '../features/common/bits';
import { Confirm } from '../features/common/Confirm';
import { CopyButton } from '../features/common/CopyButton';
import { whenRead } from '../features/common/format';
import { pageKeys, useDeliveries } from '../features/common/queries';
import { t, tr } from '../i18n';
import type { ReactNode } from 'react';

const EVENT_WORDS: Record<(typeof EVENT_TYPES)[number], string> = {
  'issue.created': 'an issue is created',
  'issue.updated': 'an issue changes',
  'issue.deleted': 'an issue is deleted',
  'issue.moved': 'an issue moves to another project',
  'sla.warning': "a help desk request's SLA target is at risk",
  'sla.breached': "a help desk request goes past its SLA target",
  'comment.created': 'someone comments',
  'comment.updated': 'a comment is edited',
  'comment.deleted': 'a comment is deleted',
  'link.created': 'issues are linked',
  'link.deleted': 'issues are unlinked',
  'work.logged': 'work is logged',
  'work.deleted': 'logged work is removed',
  'work.updated': 'logged work is corrected',
  'ai.triage.completed': 'triage suggests changes',
  'baseline.created': 'a baseline is saved',
  'project.member.added': 'someone is given a role in a project',
  'project.member.changed': 'someone’s role in a project changes',
  'project.member.removed': 'someone is taken out of a project',
  'project.visibility.changed': 'who sees a project changes',
  'attachment.added': 'a file is attached',
  'attachment.removed': 'a file is removed',
  'article.created': 'an article is written',
  'article.updated': 'an article changes or moves',
  'article.deleted': 'an article is deleted',
  'sprint.issue_added': 'an issue joins a sprint',
  'sprint.issue_removed': 'an issue leaves a sprint',
  'commit.linked': 'a commit mentions an issue',
  'pull_request.linked': 'a pull request mentions an issue',
  'pull_request.updated': 'a pull request is merged or closed',
  'rule.notified': 'a workflow rule tells people',
  'rule.called': 'a workflow rule calls it',
  'project.group.added': 'a group is given a role in a project',
  'project.group.changed': 'a group’s role in a project changes',
  'project.group.removed': 'a group is taken out of a project',
  'build.recorded': t('page.webhooks.ciReportsABuild'),
};

/** What a webhook can listen for: a rule's call goes only to the webhook the rule names. */
const SUBSCRIBABLE = EVENT_TYPES.filter((t) => t !== 'rule.called');

const VERIFY = `import { createHmac, timingSafeEqual } from 'node:crypto';

// body: the request's raw bytes, as they arrived
const mac = createHmac('sha256', secret).update(body);
const expected = 'sha256=' + mac.digest('hex');
const given = req.headers['x-a4a-signature'] ?? '';
const genuine = given.length === expected.length &&
  timingSafeEqual(Buffer.from(given), Buffer.from(expected));`;

function Deliveries({ hook }: { hook: Webhook }) {
  const deliveries = useDeliveries(hook.id, true);
  if (deliveries.isLoading) return <Loading what={t('page.webhooks.itsDeliveries')} />;
  if (deliveries.error) return <ErrorNote error={deliveries.error} />;
  if (!deliveries.data?.length) return <p className="note">{t('page.webhooks.nothingSentYetSendA')}</p>;
  return (
    <Scroll label={t('page.webhooks.tableOfRecentDeliveries')}>
      <table className="figures">
        <thead>
          <tr>
            <th scope="col">{t('page.webhooks.when')}</th>
            <th scope="col">{t('page.webhooks.event')}</th>
            <th scope="col">{t('page.webhooks.howItWent')}</th>
            <th scope="col" className="num">{t('page.webhooks.try')}</th>
            <th scope="col" className="num">{t('page.webhooks.took')}</th>
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
                <span className="mono">{d.eventType}</span>
                {d.eventId !== null ? <span className="item-about">{tr('page.webhooks.event2', { eventId: d.eventId })}</span> : <span className="item-about">{t('page.webhooks.aTest')}</span>}
              </td>
              <td>
                {d.success ? (
                  <Badge tone="good">{tr('page.webhooks.delivered', { v: d.statusCode ? `, ${d.statusCode}` : '' })}</Badge>
                ) : (
                  <Badge tone="bad">{tr('page.webhooks.failed', { v: d.statusCode ? `, ${d.statusCode}` : '' })}</Badge>
                )}
                {d.error && !d.success ? <span className="item-about">{d.error}</span> : null}
              </td>
              <td className="num">{tr('page.webhooks.of3', { attempt: d.attempt })}</td>
              <td className="num mono">{tr('page.webhooks.ms', { durationMs: d.durationMs })}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </Scroll>
  );
}

function HookCard({ hook, projectName }: { hook: Webhook; projectName?: string }) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [said, setSaid] = useState<{ text: string; bad?: boolean } | null>(null);
  const toggle = useMutation({
    // Send its events too: the PATCH body's defaults would otherwise reset them to every event.
    mutationFn: (active: boolean) => patch<Webhook>(`/webhooks/${hook.id}`, { active, events: hook.events }),
    onSuccess: (h) => {
      void qc.invalidateQueries({ queryKey: keys.webhooks });
      setSaid({ text: h.active ? t('page.webhooks.itSendsAgainFromThe') : t('page.webhooks.itIsPausedNothingIs') });
    },
    onError: (e) => setSaid({ text: errorText(e), bad: true }),
  });
  const test = useMutation({
    mutationFn: () => post<{ delivered: boolean }>(`/webhooks/${hook.id}/test`),
    onSuccess: (r) => {
      setOpen(true);
      void qc.invalidateQueries({ queryKey: pageKeys.deliveries(hook.id) });
      setSaid(r.delivered ? { text: t('page.webhooks.theTestArrived') } : { text: t('page.webhooks.theTestDidnTArrive'), bad: true });
    },
    onError: (e) => setSaid({ text: errorText(e), bad: true }),
  });
  const remove = useMutation({
    mutationFn: () => del(`/webhooks/${hook.id}`),
    onSuccess: () => void qc.invalidateQueries({ queryKey: keys.webhooks }),
    onError: (e) => setSaid({ text: errorText(e), bad: true }),
  });
  const all = hook.events.includes('*');
  return (
    <li className="card hook">
      <div className="hook-head">
        <div className="hook-what">
          <span className="mono hook-url">{hook.url}</span>
          <span className="item-about">{tr('page.webhooks.added', { v: all ? t('page.webhooks.everyChange') : t('page.webhooks.when2', { join: hook.events.map((e) => EVENT_WORDS[e as keyof typeof EVENT_WORDS] ?? e).join(', or ') }), v2: hook.project ? `in ${projectName ?? hook.project}` : 'in every project', when: ago(hook.createdAt) })}</span>
        </div>
        {hook.active ? <Badge tone="good">{t('page.webhooks.sends')}</Badge> : <Badge tone="idle">{t('page.webhooks.paused')}</Badge>}
      </div>
      <div className="cluster">
        <button type="button" onClick={() => test.mutate()} disabled={test.isPending}>
          {test.isPending ? t('page.webhooks.sending') : t('page.webhooks.sendATest')}
        </button>
        <button type="button" onClick={() => toggle.mutate(!hook.active)} disabled={toggle.isPending}>
          {hook.active ? t('page.webhooks.pauseIt') : t('page.webhooks.turnItBackOn')}
        </button>
        <button type="button" className="link" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
          {open ? t('page.webhooks.hideItsDeliveries') : t('page.webhooks.showItsDeliveries')}
        </button>
        <span className="grow" />
        <Confirm
          small
          label={t('page.webhooks.deleteIt')}
          title={t('page.webhooks.deleteTheWebhookTo', { url: hook.url })}
          about={t('page.webhooks.a4aStopsSendingToIt')}
          confirm={t('page.webhooks.deleteIt')}
          disabled={remove.isPending}
          onConfirm={() => remove.mutate()}
        />
      </div>
      <Said text={said?.text} tone={said?.bad ? 'bad' : undefined} />
      {open ? (
        <div className="hook-log">
          <h3>{t('page.webhooks.recentDeliveries')}</h3>
          <Deliveries hook={hook} />
        </div>
      ) : null}
    </li>
  );
}

function AddHook() {
  const qc = useQueryClient();
  const projects = useProjects();
  const [url, setUrl] = useState('');
  const [all, setAll] = useState(true);
  const [events, setEvents] = useState<Set<string>>(() => new Set(['issue.created', 'issue.updated']));
  const [project, setProject] = useState('');
  const [created, setCreated] = useState<(Webhook & { secret: string }) | null>(null);
  const add = useMutation({
    mutationFn: () =>
      post<Webhook & { secret: string }>('/webhooks', {
        url: url.trim(),
        events: all ? ['*'] : SUBSCRIBABLE.filter((e) => events.has(e)),
        project: project || null,
        active: true,
      }),
    onSuccess: (h) => {
      setCreated(h);
      setUrl('');
      void qc.invalidateQueries({ queryKey: keys.webhooks });
    },
  });
  return (
    <section className="card" aria-labelledby="add-hook">
      <h2 id="add-hook">{t('page.webhooks.addAWebhook')}</h2>
      <form
        className="form"
        onSubmit={(e) => {
          e.preventDefault();
          add.mutate();
        }}
      >
        <div className="form-fields">
          <FormField
            label={t('page.webhooks.whereToSend')}
            help={t('page.webhooks.a4aPostsToItFrom')}
            className="tw:col-span-full"
          >
            {(id, help) => (
              <input
                id={id}
                aria-describedby={help}
                type="url"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                required
                placeholder="https://ci.example.com/a4a"
                className="mono"
              />
            )}
          </FormField>
          <FormField label={t('page.webhooks.from')}>
            {(id) => (
              <select id={id} value={project} onChange={(e) => setProject(e.target.value)}>
                <option value="">{t('page.webhooks.everyProject')}</option>
                {(projects.data ?? []).map((p) => (
                  <option key={p.key} value={p.key}>{tr('page.webhooks.only', { key: p.key })}</option>
                ))}
              </select>
            )}
          </FormField>
        </div>
        <fieldset className="choice-group columns">
          <legend>{t('page.webhooks.when')}</legend>
          <label className="choice tw:col-span-full">
            <input type="checkbox" checked={all} onChange={(e) => setAll(e.target.checked)} />
            <span>{t('page.webhooks.everyChangeIncludingKindsAdded')}</span>
          </label>
          {!all
            ? SUBSCRIBABLE.map((t) => (
                <label key={t} className="choice">
                  <input
                    type="checkbox"
                    checked={events.has(t)}
                    onChange={() =>
                      setEvents((s) => {
                        const n = new Set(s);
                        if (n.has(t)) n.delete(t);
                        else n.add(t);
                        return n;
                      })
                    }
                  />
                  <span>
                    {EVENT_WORDS[t][0]!.toUpperCase() + EVENT_WORDS[t].slice(1)}
                    <small className="field-help mono">{t}</small>
                  </span>
                </label>
              ))
            : null}
        </fieldset>
        <div className="cluster">
          <button type="submit" className="primary" disabled={add.isPending || !url.trim() || (!all && !events.size)}>
            {add.isPending ? t('page.webhooks.adding') : t('page.webhooks.addTheWebhook')}
          </button>
        </div>
        {add.error ? <ErrorNote error={add.error} /> : null}
      </form>
      {created ? (
        <div className="secret" role="status">
          <p>{tr('page.webhooks.copyItsSecretNowThis', { t0: (c: ReactNode) => <strong>{c}</strong> })}</p>
          <code>{created.secret}</code>
          <div className="cluster">
            <CopyButton text={created.secret} label={t('page.webhooks.copyTheSecret')} what={t('page.webhooks.theSecret')} />
            <button type="button" className="link" onClick={() => setCreated(null)}>{t('page.webhooks.iVeKeptIt')}</button>
          </div>
        </div>
      ) : null}
    </section>
  );
}

/** Where a4a sends each change, signed: the addresses, a test, and how each delivery went. */
export default function WebhooksPage() {
  const hooks = useWebhooks();
  const projects = useProjects();
  const names = new Map((projects.data ?? []).map((p) => [p.key, p.name]));
  return (
    <AdminOnly title={t('page.webhooks.webhooks')}>
      <PageHead
        title={t('page.webhooks.webhooks')}
        about={t('page.webhooks.a4aPostsEachChangeTo')}
      />
      <section className="card" aria-labelledby="hooks">
        <h2 id="hooks">{t('page.webhooks.whereItSends')}</h2>
        {hooks.isLoading ? <Loading what="webhooks" /> : null}
        {hooks.error ? <ErrorNote error={hooks.error} /> : null}
        {hooks.data && !hooks.data.length ? <p className="note">{t('page.webhooks.nowhereYetAddAWebhook')}</p> : null}
        {hooks.data?.length ? (
          <ul className="hooks">
            {hooks.data.map((h) => (
              <HookCard key={h.id} hook={h} projectName={h.project ? names.get(h.project) : undefined} />
            ))}
          </ul>
        ) : null}
      </section>
      <div className="tw:grid tw:grid-cols-[repeat(auto-fit,minmax(min(100%,24rem),1fr))] tw:items-start tw:gap-x-4">
        <AddHook />
        <section className="card" aria-labelledby="how">
          <h2 id="how">{t('page.webhooks.howDeliveriesWork')}</h2>
          <p className="note">{t('page.webhooks.eachDeliveryIsAPost')}</p>
          <dl className="facts-list">
            <div className="pair">
              <dt>{t('page.webhooks.signed')}</dt>
              <dd>{tr('page.webhooks.anHmacSha256OfThe', { code: <code>X-A4A-Signature: sha256=&lt;HMAC of the body&gt;</code> })}</dd>
            </div>
            <div className="pair">
              <dt>{t('page.webhooks.atLeastOnce')}</dt>
              <dd>{tr('page.webhooks.aChangeCanArriveTwice', { code: <code>X-A4A-Event-Id</code> })}</dd>
            </div>
            <div className="pair">
              <dt>{t('page.webhooks.retried')}</dt>
              <dd>{t('page.webhooks.upTo3TriesA')}</dd>
            </div>
            <div className="pair">
              <dt>{t('page.webhooks.alsoSent')}</dt>
              <dd>{tr('page.webhooks.itsKindAndTheTry', { code: <code>X-A4A-Event</code>, code2: <code>X-A4A-Delivery</code> })}</dd>
            </div>
          </dl>
          <h3>{t('page.webhooks.checkingTheSignatureInNode')}</h3>
          <div className="stack tight">
            <pre className="snippet code" tabIndex={0} aria-label={t('page.webhooks.checkingTheSignatureInNode')}>
              {VERIFY}
            </pre>
            <div className="cluster">
              <CopyButton text={VERIFY} label={t('page.webhooks.copyIt')} what={t('page.webhooks.theCheck')} />
            </div>
          </div>
        </section>
      </div>
    </AdminOnly>
  );
}

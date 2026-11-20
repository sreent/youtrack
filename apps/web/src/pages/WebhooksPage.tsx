import type { Webhook } from '@a4a/shared';
import { EVENT_TYPES } from '@a4a/shared/constants';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { del, patch, post } from '../api/client';
import { keys, useProjects, useWebhooks } from '../api/queries';
import { agoSaid, Badge } from '../components/Badges';
import { ErrorNote, Loading, PageHead } from '../components/States';
import { AdminOnly, errorText, FormField, Said, Scroll } from '../features/common/bits';
import { Confirm } from '../features/common/Confirm';
import { CopyButton } from '../features/common/CopyButton';
import { whenRead } from '../features/common/format';
import { pageKeys, useDeliveries } from '../features/common/queries';
import { formatList, t, tr } from '../i18n';
import type { ReactNode } from 'react';

const EVENT_WORDS: Record<(typeof EVENT_TYPES)[number], string> = {
  'issue.created': t('page.webhooks.anIssueIsCreated'),
  'issue.updated': t('page.webhooks.anIssueChanges'),
  'issue.deleted': t('page.webhooks.anIssueIsDeleted'),
  'issue.moved': t('page.webhooks.anIssueMovesToAnother'),
  'sla.warning': t('page.webhooks.aHelpDeskRequestS'),
  'sla.breached': t('page.webhooks.aHelpDeskRequestGoes'),
  'comment.created': t('page.webhooks.someoneComments'),
  'comment.updated': t('page.webhooks.aCommentIsEdited'),
  'comment.deleted': t('page.webhooks.aCommentIsDeleted'),
  'link.created': t('page.webhooks.issuesAreLinked'),
  'link.deleted': t('page.webhooks.issuesAreUnlinked'),
  'work.logged': t('page.webhooks.workIsLogged'),
  'work.deleted': t('page.webhooks.loggedWorkIsRemoved'),
  'work.updated': t('page.webhooks.loggedWorkIsCorrected'),
  'ai.triage.completed': t('page.webhooks.triageSuggestsChanges'),
  'baseline.created': t('page.webhooks.aBaselineIsSaved'),
  'project.member.added': t('page.webhooks.someoneIsGivenARole'),
  'project.member.changed': t('page.webhooks.someoneSRoleInA'),
  'project.member.removed': t('page.webhooks.someoneIsTakenOutOf'),
  'project.visibility.changed': t('page.webhooks.whoSeesAProjectChanges'),
  'attachment.added': t('page.webhooks.aFileIsAttached'),
  'attachment.removed': t('page.webhooks.aFileIsRemoved'),
  'article.created': t('page.webhooks.anArticleIsWritten'),
  'article.updated': t('page.webhooks.anArticleChangesOrMoves'),
  'article.deleted': t('page.webhooks.anArticleIsDeleted'),
  'sprint.issue_added': t('page.webhooks.anIssueJoinsASprint'),
  'sprint.issue_removed': t('page.webhooks.anIssueLeavesASprint'),
  'commit.linked': t('page.webhooks.aCommitMentionsAnIssue'),
  'pull_request.linked': t('page.webhooks.aPullRequestMentionsAn'),
  'pull_request.updated': t('page.webhooks.aPullRequestIsMerged'),
  'rule.notified': t('page.webhooks.aWorkflowRuleTellsPeople'),
  'rule.called': t('page.webhooks.aWorkflowRuleCallsIt'),
  'script.called': t('page.webhooks.aWorkflowScriptCallsIt'),
  'project.group.added': t('page.webhooks.aGroupIsGivenA'),
  'project.group.changed': t('page.webhooks.aGroupSRoleIn'),
  'project.group.removed': t('page.webhooks.aGroupIsTakenOut'),
  'build.recorded': t('page.webhooks.ciReportsABuild'),
  'project.key.changed': t('page.webhooks.aProjectSKeyIsRenamed'),
  'board.issue_ranked': t('page.webhooks.anIssueIsRankedOnABoard'),
  'request.cc_added': t('page.webhooks.someoneIsCopiedOnARequest'),
  'request.cc_removed': t('page.webhooks.someoneStopsBeingCopied'),
  'whiteboard.created': t('page.webhooks.aWhiteboardIsMade'),
  'whiteboard.renamed': t('page.webhooks.aWhiteboardIsRenamed'),
  'whiteboard.deleted': t('page.webhooks.aWhiteboardIsDeleted'),
  'whiteboard.converted': t('page.webhooks.issuesAreMadeFromAWhiteboard'),
  'project.portal_sign_in.changed': t('page.webhooks.howRequestersSignInChanges'),
  'project.request_ccs.changed': t('page.webhooks.requestCcRulesChange'),
};

/** What a webhook can listen for: a rule's call goes only to the webhook the rule names. */
type Subscribable = Exclude<(typeof EVENT_TYPES)[number], 'rule.called' | 'script.called'>;
const SUBSCRIBABLE = EVENT_TYPES.filter((t): t is Subscribable => t !== 'rule.called' && t !== 'script.called');

/** What the form's checkboxes say, each a label of its own: EVENT_WORDS' are clauses that follow "When" in a sentence. */
const EVENT_LABELS: Record<Subscribable, string> = {
  'issue.created': t('page.webhooks.label.issueCreated'),
  'issue.updated': t('page.webhooks.label.issueUpdated'),
  'issue.deleted': t('page.webhooks.label.issueDeleted'),
  'issue.moved': t('page.webhooks.label.issueMoved'),
  'sla.warning': t('page.webhooks.label.slaWarning'),
  'sla.breached': t('page.webhooks.label.slaBreached'),
  'comment.created': t('page.webhooks.label.commentCreated'),
  'comment.updated': t('page.webhooks.label.commentUpdated'),
  'comment.deleted': t('page.webhooks.label.commentDeleted'),
  'link.created': t('page.webhooks.label.linkCreated'),
  'link.deleted': t('page.webhooks.label.linkDeleted'),
  'work.logged': t('page.webhooks.label.workLogged'),
  'work.deleted': t('page.webhooks.label.workDeleted'),
  'work.updated': t('page.webhooks.label.workUpdated'),
  'ai.triage.completed': t('page.webhooks.label.aiTriageCompleted'),
  'baseline.created': t('page.webhooks.label.baselineCreated'),
  'project.member.added': t('page.webhooks.label.projectMemberAdded'),
  'project.member.changed': t('page.webhooks.label.projectMemberChanged'),
  'project.member.removed': t('page.webhooks.label.projectMemberRemoved'),
  'project.visibility.changed': t('page.webhooks.label.projectVisibilityChanged'),
  'attachment.added': t('page.webhooks.label.attachmentAdded'),
  'attachment.removed': t('page.webhooks.label.attachmentRemoved'),
  'article.created': t('page.webhooks.label.articleCreated'),
  'article.updated': t('page.webhooks.label.articleUpdated'),
  'article.deleted': t('page.webhooks.label.articleDeleted'),
  'sprint.issue_added': t('page.webhooks.label.sprintIssueAdded'),
  'sprint.issue_removed': t('page.webhooks.label.sprintIssueRemoved'),
  'commit.linked': t('page.webhooks.label.commitLinked'),
  'pull_request.linked': t('page.webhooks.label.pullRequestLinked'),
  'pull_request.updated': t('page.webhooks.label.pullRequestUpdated'),
  'rule.notified': t('page.webhooks.label.ruleNotified'),
  'project.group.added': t('page.webhooks.label.projectGroupAdded'),
  'project.group.changed': t('page.webhooks.label.projectGroupChanged'),
  'project.group.removed': t('page.webhooks.label.projectGroupRemoved'),
  'build.recorded': t('page.webhooks.label.buildRecorded'),
  'project.key.changed': t('page.webhooks.label.projectKeyChanged'),
  'board.issue_ranked': t('page.webhooks.label.boardIssueRanked'),
  'request.cc_added': t('page.webhooks.label.requestCcAdded'),
  'request.cc_removed': t('page.webhooks.label.requestCcRemoved'),
  'whiteboard.created': t('page.webhooks.label.whiteboardCreated'),
  'whiteboard.renamed': t('page.webhooks.label.whiteboardRenamed'),
  'whiteboard.deleted': t('page.webhooks.label.whiteboardDeleted'),
  'whiteboard.converted': t('page.webhooks.label.whiteboardConverted'),
  'project.portal_sign_in.changed': t('page.webhooks.label.projectPortalSignInChanged'),
  'project.request_ccs.changed': t('page.webhooks.label.projectRequestCcsChanged'),
};

const VERIFY = `import { createHmac, timingSafeEqual } from 'node:crypto';

// body: the request's raw bytes, as they arrived
const mac = createHmac('sha256', secret).update(body);
const expected = 'sha256=' + mac.digest('hex');
const given = req.headers['x-a4a-signature'] ?? '';
const genuine = given.length === expected.length &&
  timingSafeEqual(Buffer.from(given), Buffer.from(expected));`;

function Deliveries({ hook }: { hook: Webhook }) {
  const deliveries = useDeliveries(hook.id, true);
  if (deliveries.isLoading) return <Loading what="loadingLine.webhookDeliveries" />;
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
                  <Badge tone="good">{t('page.webhooks.delivered', { hasCode: d.statusCode ? 'yes' : 'no', code: d.statusCode ?? '' })}</Badge>
                ) : (
                  <Badge tone="bad">{t('page.webhooks.failed', { hasCode: d.statusCode ? 'yes' : 'no', code: d.statusCode ?? '' })}</Badge>
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
          <span className="item-about">{tr('page.webhooks.added', { v: all ? t('page.webhooks.everyChange') : t('page.webhooks.when2', { join: formatList(hook.events.map((e) => EVENT_WORDS[e as keyof typeof EVENT_WORDS] ?? e), 'disjunction') }), v2: hook.project ? t('page.webhooks.in', { v: projectName ?? hook.project }) : t('page.webhooks.inEveryProject'), when: agoSaid(hook.createdAt) })}</span>
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
          <legend>{t('page.webhooks.sendsWhen')}</legend>
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
                    {EVENT_LABELS[t]}
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
        {hooks.isLoading ? <Loading what="loadingLine.webhooks" /> : null}
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

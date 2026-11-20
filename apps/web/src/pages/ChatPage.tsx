import type { ChatStatus } from '@a4a/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { del, get, post } from '../api/client';
import { agoSaid, Badge } from '../components/Badges';
import { ErrorNote, Loading, PageHead } from '../components/States';
import { UserWho } from '../components/Who';
import { chatKeys, ChatSubscriptionTable, useChatSubscriptions } from '../features/chat/Chat';
import { AdminOnly, errorText, FormField, Said } from '../features/common/bits';
import { Confirm } from '../features/common/Confirm';
import { CopyButton } from '../features/common/CopyButton';
import { listNodes, problemWords, t as tx, tr } from '../i18n';

const useChatStatus = () => useQuery({ queryKey: chatKeys.status, queryFn: () => get<ChatStatus>('/chat/status') });

/** The Teams bot: set up from the server's settings, its app package, and the teams it's in. */
function Teams({ status }: { status: ChatStatus }) {
  const t = status.teams;
  const channels = status.channels.filter((c) => c.platform === 'teams');
  if (!t.configured) {
    return (
      <div className="stack">
        <p className="note">{tr('page.chat.notSetUpRegisterA', { code: <code>TEAMS_APP_ID</code>, code2: <code>TEAMS_APP_PASSWORD</code>, code3: <code>TEAMS_TENANT_ID</code> })}</p>
        <div className="cluster">
          <span className="note">{tx('page.chat.itsMessagingEndpoint')}</span>
          <code>{t.messagingEndpoint}</code>
          <CopyButton text={t.messagingEndpoint} label={tx('page.chat.copyIt')} what={tx('page.chat.theMessagingEndpoint')} />
        </div>
      </div>
    );
  }
  return (
    <div className="stack">
      <dl className="facts-list">
        <div className="pair">
          <dt>{tx('page.chat.bot')}</dt>
          <dd className="mono">{t.botId}</dd>
        </div>
        <div className="pair">
          <dt>{tx('page.chat.tenant')}</dt>
          <dd className="mono">{t.tenantId}</dd>
        </div>
        <div className="pair">
          <dt>{tx('page.chat.messagingEndpoint')}</dt>
          <dd className="cluster">
            <code>{t.messagingEndpoint}</code>
            <CopyButton text={t.messagingEndpoint} label={tx('page.chat.copyIt')} what={tx('page.chat.theMessagingEndpoint')} />
          </dd>
        </div>
      </dl>
      <div className="cluster">
        <a className="button" href="/api/v1/chat/teams/app-package" download="a4a-teams.zip">{tx('page.chat.downloadTheTeamsApp')}</a>
        <span className="note">{tx('page.chat.uploadItInTeamsAdmin')}</span>
      </div>
      {t.teams.length ? (
        <ul className="plain" aria-label={tx('page.chat.teamsA4aIsIn')}>
          {t.teams.map((team) => (
            <li key={team.id} className="cluster spread">
              <span>
                <span className="item-name">{team.name}</span>
                <span className="item-about">{tr('page.chat.addedChannels', { when: agoSaid(team.installedAt), length: channels.filter((c) => c.workspace === team.name && !c.gone).length })}</span>
                {team.removed ? <span className="item-about">{problemWords(team.removedSaid) ?? team.removed}</span> : null}
              </span>
              {team.removed ? <Badge tone="idle">{tx('chat.chat.stopped')}</Badge> : <Badge tone="good">{tx('page.chat.inTheTeam')}</Badge>}
            </li>
          ))}
        </ul>
      ) : (
        <p className="note">{tx('page.chat.inNoTeamYetOnce')}</p>
      )}
    </div>
  );
}

/** Matrix: one homeserver, connected with its bot account's access token. */
function Matrix({ status }: { status: ChatStatus }) {
  const qc = useQueryClient();
  const s = status.matrix;
  const [homeserver, setHomeserver] = useState('');
  const [token, setToken] = useState('');
  const [said, setSaid] = useState<{ text: string; bad?: boolean } | null>(null);
  const connect = useMutation({
    mutationFn: () => post<ChatStatus>('/chat/matrix', { homeserver: homeserver.trim(), accessToken: token.trim() }),
    onSuccess: (next) => {
      qc.setQueryData(chatKeys.status, next);
      void qc.invalidateQueries({ queryKey: chatKeys.all });
      setHomeserver('');
      setToken('');
      setSaid({ text: tx('page.chat.connectedToMatrix', { home: next.matrix.homeserver }) });
    },
    onError: (e) => setSaid({ text: errorText(e), bad: true }),
  });
  const disconnect = useMutation({
    mutationFn: () => del('/chat/matrix'),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: chatKeys.all });
      setSaid({ text: tx('page.chat.disconnectedItsChannelsSubscriptionsHave') });
    },
    onError: (e) => setSaid({ text: errorText(e), bad: true }),
  });
  const refresh = useMutation({
    mutationFn: () => post<ChatStatus>('/chat/matrix/rooms', {}),
    onSuccess: (next) => {
      qc.setQueryData(chatKeys.status, next);
      void qc.invalidateQueries({ queryKey: chatKeys.all });
      setSaid({ text: tx('page.chat.readItsRooms') });
    },
    onError: (e) => setSaid({ text: errorText(e), bad: true }),
  });
  return (
    <div className="stack">
      {s.connected ? (
        <div className="cluster spread">
          <span>
            <span className="item-name">{s.userId}</span>
            <span className="item-about">{tr('page.chat.connectedBy', { v: s.connectedAt ? agoSaid(s.connectedAt) : '', el: <UserWho user={s.connectedBy} small /> })}</span>
          </span>
          <span className="cluster">
            <button type="button" onClick={() => refresh.mutate()} disabled={refresh.isPending}>
              {tx('page.chat.readRooms')}
            </button>
            <Confirm
              small
              label={tx('page.chat.disconnect')}
              title={tx('page.chat.disconnectMatrix', { home: s.homeserver })}
              about={tx('page.chat.itsChannelsSubscriptionsStopAnd')}
              confirm={tx('page.chat.disconnectIt')}
              disabled={disconnect.isPending}
              onConfirm={() => disconnect.mutate()}
            />
          </span>
        </div>
      ) : (
        <form
          className="form"
          onSubmit={(e) => {
            e.preventDefault();
            connect.mutate();
          }}
        >
          {s.removed ? (
            <p className="note">
              <Badge tone="idle">{tx('chat.chat.stopped')}</Badge> {problemWords(s.removedSaid) ?? s.removed}
            </p>
          ) : null}
          <FormField label={tx('page.chat.matrixHomeserver')} help={tx('page.chat.matrixHomeserverHelp')}>
            {(id, help) => <input id={id} aria-describedby={help} value={homeserver} onChange={(e) => setHomeserver(e.target.value)} placeholder="https://matrix.org" required className="mono" />}
          </FormField>
          <FormField label={tx('page.chat.matrixToken')} help={tx('page.chat.matrixTokenHelp')}>
            {(id, help) => <input id={id} aria-describedby={help} type="password" value={token} onChange={(e) => setToken(e.target.value)} autoComplete="off" required className="mono" />}
          </FormField>
          <div className="cluster">
            <button type="submit" className="primary" disabled={!homeserver.trim() || !token.trim() || connect.isPending}>
              {connect.isPending ? tx('page.chat.connecting') : tx('page.chat.connectMatrix')}
            </button>
          </div>
        </form>
      )}
      {said ? <Said text={said.text} tone={said.bad ? 'bad' : undefined} /> : null}
    </div>
  );
}

/** Slack: one workspace, connected with its app's token and signing secret. */
function Slack({ status }: { status: ChatStatus }) {
  const qc = useQueryClient();
  const s = status.slack;
  const [token, setToken] = useState('');
  const [secret, setSecret] = useState('');
  const [said, setSaid] = useState<{ text: string; bad?: boolean } | null>(null);
  const connect = useMutation({
    mutationFn: () => post<ChatStatus>('/chat/slack', { botToken: token.trim(), signingSecret: secret.trim() }),
    onSuccess: (next) => {
      qc.setQueryData(chatKeys.status, next);
      void qc.invalidateQueries({ queryKey: chatKeys.all });
      setToken('');
      setSecret('');
      setSaid({ text: tx('page.chat.connectedTo', { workspace: next.slack.workspace }) });
    },
    onError: (e) => setSaid({ text: errorText(e), bad: true }),
  });
  const disconnect = useMutation({
    mutationFn: () => del('/chat/slack'),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: chatKeys.all });
      setSaid({ text: tx('page.chat.disconnectedItsChannelsSubscriptionsHave') });
    },
    onError: (e) => setSaid({ text: errorText(e), bad: true }),
  });
  const urls = [
    { name: 'Slash command /a4a', url: s.requestUrls.commands },
    { name: 'Interactivity', url: s.requestUrls.interactivity },
    { name: 'Event subscriptions', url: s.requestUrls.events },
  ];
  return (
    <div className="stack">
      {s.connected ? (
        <div className="cluster spread">
          <span>
            <span className="item-name">{s.workspace}</span>
            <span className="item-about">{tr('page.chat.connectedBy', { v: s.connectedAt ? agoSaid(s.connectedAt) : '', el: <UserWho user={s.connectedBy} small /> })}</span>
          </span>
          <Confirm
            small
            label={tx('page.chat.disconnect')}
            title={tx('page.chat.disconnect2', { workspace: s.workspace })}
            about={tx('page.chat.itsChannelsSubscriptionsStopAnd')}
            confirm={tx('page.chat.disconnectIt')}
            disabled={disconnect.isPending}
            onConfirm={() => disconnect.mutate()}
          />
        </div>
      ) : (
        <form
          className="form"
          onSubmit={(e) => {
            e.preventDefault();
            connect.mutate();
          }}
        >
          {s.removed ? (
            <p className="note">
              <Badge tone="idle">{tx('chat.chat.stopped')}</Badge> {problemWords(s.removedSaid) ?? s.removed}
            </p>
          ) : null}
          <FormField label={tx('page.chat.botToken')} help={tx('page.chat.underOauthPermissionsInThe')}>
            {(id, help) => <input id={id} aria-describedby={help} type="password" value={token} onChange={(e) => setToken(e.target.value)} autoComplete="off" required className="mono" />}
          </FormField>
          <FormField label={tx('page.chat.signingSecret')} help={tx('page.chat.underBasicInformationA4aChecks')}>
            {(id, help) => <input id={id} aria-describedby={help} type="password" value={secret} onChange={(e) => setSecret(e.target.value)} autoComplete="off" required className="mono" />}
          </FormField>
          <div className="cluster">
            <button type="submit" className="primary" disabled={!token.trim() || !secret.trim() || connect.isPending}>
              {connect.isPending ? tx('page.chat.connecting') : tx('page.chat.connectSlack')}
            </button>
          </div>
        </form>
      )}
      <Said text={said?.text} tone={said?.bad ? 'bad' : undefined} />
      <dl className="facts-list">
        {urls.map((u) => (
          <div className="pair" key={u.name}>
            <dt>{u.name}</dt>
            <dd className="cluster">
              <code>{u.url}</code>
              <CopyButton text={u.url} label={tx('page.chat.copyIt')} what={tx('page.chat.theUrl', { name: u.name })} />
            </dd>
          </div>
        ))}
      </dl>
      <p className="note">{tr('page.chat.theAppNeedsTheScopes', { code: <code>chat:write</code>, code2: <code>commands</code>, code3: <code>channels:read</code>, code4: <code>groups:read</code>, code5: <code>links:read</code>, code6: <code>links:write</code>, events: listNodes(SLACK_EVENTS.map((e) => <code key={e}>{e}</code>)) })}</p>
      <p className="note">{tr('page.chat.issuesFromMessagesNeed', { code: <code>channels:history</code>, code2: <code>groups:history</code>, code3: <code>users:read</code>, code4: <code>a4a_create_issue</code> })}</p>
    </div>
  );
}

/** The events the Slack app subscribes to: each one `chat/slack.ts` handles. */
const SLACK_EVENTS = ['link_shared', 'member_joined_channel', 'member_left_channel', 'channel_deleted', 'group_deleted', 'channel_archive', 'group_archive', 'channel_rename', 'group_rename', 'app_uninstalled', 'tokens_revoked'];

function Everywhere() {
  const subs = useChatSubscriptions();
  // Said here, not in the table: stopping the last subscription takes the table away.
  const [said, setSaid] = useState<{ text: string; bad?: boolean } | null>(null);
  if (subs.isLoading) return <Loading what="loadingLine.subscriptions" />;
  if (subs.error || !subs.data) return <ErrorNote error={subs.error} />;
  return (
    <div className="stack">
      {subs.data.length ? (
        <ChatSubscriptionTable subs={subs.data} showTarget label={tx('page.chat.tableOfWhatSSubscribed')} onSaid={setSaid} />
      ) : (
        <p className="note">{tx('page.chat.noChannelHearsOfAnything')}</p>
      )}
      <Said text={said?.text} tone={said?.bad ? 'bad' : undefined} />
    </div>
  );
}

/** Teams and Slack: what's connected, how, and which channels hear of what. */
export default function ChatPage() {
  const status = useChatStatus();
  return (
    <AdminOnly title={tx('page.chat.chat')}>
      <PageHead
        title={tx('page.chat.chat')}
        about={tx('page.chat.microsoftTeamsAndSlackChannels')}
      />
      {status.isLoading ? <Loading what="loadingLine.chat" /> : null}
      {status.error ? <ErrorNote error={status.error} /> : null}
      {status.data ? (
        <>
          <div className="tw:grid tw:grid-cols-[repeat(auto-fit,minmax(min(100%,24rem),1fr))] tw:items-start tw:gap-x-4">
            <section className="card" aria-labelledby="chat-teams">
              <div className="section-head">
                <h2 id="chat-teams">{tx('page.chat.microsoftTeams')}</h2>
                {status.data.teams.configured ? <Badge tone="good">{tx('page.chat.setUp')}</Badge> : <Badge tone="idle">{tx('page.chat.notSetUp')}</Badge>}
              </div>
              <Teams status={status.data} />
            </section>
            <section className="card" aria-labelledby="chat-slack">
              <div className="section-head">
                <h2 id="chat-slack">{tx('page.chat.slack')}</h2>
                {status.data.slack.connected ? <Badge tone="good">{tx('page.chat.connected')}</Badge> : <Badge tone="idle">{tx('page.chat.notConnected')}</Badge>}
              </div>
              <Slack status={status.data} />
      <section className="card" aria-labelledby="chat-matrix">
        <h2 id="chat-matrix">{tx('page.chat.matrix')}</h2>
        {status.data.matrix.connected ? <Badge tone="good">{tx('page.chat.connected')}</Badge> : <Badge tone="idle">{tx('page.chat.notConnected')}</Badge>}
        <p className="note">{tx('page.chat.matrixAbout')}</p>
        <Matrix status={status.data} />
      </section>
            </section>
          </div>
          <section className="card" aria-labelledby="chat-where">
            <div className="section-head">
              <h2 id="chat-where">{tx('page.chat.whatSSubscribedWhere')}</h2>
              <span className="note">{tx('page.chat.aChannelIsToldOnly')}</span>
            </div>
            <Everywhere />
          </section>
        </>
      ) : null}
    </AdminOnly>
  );
}

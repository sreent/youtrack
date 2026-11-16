import type { ChatStatus } from '@a4a/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { del, get, post } from '../api/client';
import { ago, Badge } from '../components/Badges';
import { ErrorNote, Loading, PageHead } from '../components/States';
import { UserWho } from '../components/Who';
import { chatKeys, ChatSubscriptionTable, useChatSubscriptions } from '../features/chat/Chat';
import { AdminOnly, errorText, FormField, Said } from '../features/common/bits';
import { Confirm } from '../features/common/Confirm';
import { CopyButton } from '../features/common/CopyButton';

const useChatStatus = () => useQuery({ queryKey: chatKeys.status, queryFn: () => get<ChatStatus>('/chat/status') });

/** The Teams bot: set up from the server's settings, its app package, and the teams it's in. */
function Teams({ status }: { status: ChatStatus }) {
  const t = status.teams;
  const channels = status.channels.filter((c) => c.platform === 'teams');
  if (!t.configured) {
    return (
      <div className="stack">
        <p className="note">
          Not set up. Register a bot with Azure Bot Service on a single-tenant Entra app (the one a4a signs people in with, or its own), then set{' '}
          <code>TEAMS_APP_ID</code>, <code>TEAMS_APP_PASSWORD</code> and <code>TEAMS_TENANT_ID</code> on the server, and restart it.
        </p>
        <div className="cluster">
          <span className="note">Its messaging endpoint</span>
          <code>{t.messagingEndpoint}</code>
          <CopyButton text={t.messagingEndpoint} label="Copy it" what="the messaging endpoint" />
        </div>
      </div>
    );
  }
  return (
    <div className="stack">
      <dl className="facts-list">
        <div className="pair">
          <dt>Bot</dt>
          <dd className="mono">{t.botId}</dd>
        </div>
        <div className="pair">
          <dt>Tenant</dt>
          <dd className="mono">{t.tenantId}</dd>
        </div>
        <div className="pair">
          <dt>Messaging endpoint</dt>
          <dd className="cluster">
            <code>{t.messagingEndpoint}</code>
            <CopyButton text={t.messagingEndpoint} label="Copy it" what="the messaging endpoint" />
          </dd>
        </div>
      </dl>
      <div className="cluster">
        <a className="button" href="/api/v1/chat/teams/app-package" download="a4a-teams.zip">
          Download the Teams app
        </a>
        <span className="note">Upload it in Teams’ admin center, under Manage apps, then add it to a team.</span>
      </div>
      {t.teams.length ? (
        <ul className="plain" aria-label="Teams a4a is in">
          {t.teams.map((team) => (
            <li key={team.id} className="cluster spread">
              <span>
                <span className="item-name">{team.name}</span>
                <span className="item-about">
                  added {ago(team.installedAt)} · {channels.filter((c) => c.workspace === team.name && !c.gone).length} channels
                </span>
              </span>
              {team.removed ? <Badge tone="idle">{team.removed}</Badge> : <Badge tone="good">in the team</Badge>}
            </li>
          ))}
        </ul>
      ) : (
        <p className="note">In no team yet. Once the app is added to a team, its channels are listed here.</p>
      )}
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
      setSaid({ text: `Connected to ${next.slack.workspace}.` });
    },
    onError: (e) => setSaid({ text: errorText(e), bad: true }),
  });
  const disconnect = useMutation({
    mutationFn: () => del('/chat/slack'),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: chatKeys.all });
      setSaid({ text: 'Disconnected. Its channels’ subscriptions have stopped.' });
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
            <span className="item-about">
              connected {s.connectedAt ? ago(s.connectedAt) : ''} by <UserWho user={s.connectedBy} small />
            </span>
          </span>
          <Confirm
            small
            label="Disconnect"
            title={`Disconnect ${s.workspace}?`}
            about="Its channels’ subscriptions stop, and a4a forgets the token and the signing secret. Linked people stay linked, for when it’s connected again."
            confirm="Disconnect it"
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
          {s.removed ? <p className="note">It stopped: {s.removed}.</p> : null}
          <FormField label="Bot token" help="Under OAuth & Permissions in the app’s settings: it starts with xoxb-. Kept sealed.">
            {(id, help) => <input id={id} aria-describedby={help} type="password" value={token} onChange={(e) => setToken(e.target.value)} autoComplete="off" required className="mono" />}
          </FormField>
          <FormField label="Signing secret" help="Under Basic Information. a4a checks every request Slack sends with it. Kept sealed.">
            {(id, help) => <input id={id} aria-describedby={help} type="password" value={secret} onChange={(e) => setSecret(e.target.value)} autoComplete="off" required className="mono" />}
          </FormField>
          <div className="cluster">
            <button type="submit" className="primary" disabled={!token.trim() || !secret.trim() || connect.isPending}>
              {connect.isPending ? 'Connecting…' : 'Connect Slack'}
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
              <CopyButton text={u.url} label="Copy it" what={`the ${u.name} URL`} />
            </dd>
          </div>
        ))}
      </dl>
      <p className="note">
        The app needs the scopes <code>chat:write</code>, <code>commands</code>, <code>channels:read</code>, <code>groups:read</code> and <code>links:read</code> with{' '}
        <code>links:write</code>, and the events <code>link_shared</code>, <code>member_joined_channel</code>, <code>channel_deleted</code>, <code>channel_archive</code>,{' '}
        <code>channel_rename</code> and <code>app_uninstalled</code>.
      </p>
    </div>
  );
}

function Everywhere() {
  const subs = useChatSubscriptions();
  // Said here, not in the table: stopping the last subscription takes the table away.
  const [said, setSaid] = useState<{ text: string; bad?: boolean } | null>(null);
  if (subs.isLoading) return <Loading what="subscriptions" />;
  if (subs.error || !subs.data) return <ErrorNote error={subs.error} />;
  return (
    <div className="stack">
      {subs.data.length ? (
        <ChatSubscriptionTable subs={subs.data} showTarget label="Table of what's subscribed where" onSaid={setSaid} />
      ) : (
        <p className="note">No channel hears of anything yet. A channel is subscribed on a project’s page, or by asking the bot in it: subscribe BACK.</p>
      )}
      <Said text={said?.text} tone={said?.bad ? 'bad' : undefined} />
    </div>
  );
}

/** Teams and Slack: what's connected, how, and which channels hear of what. */
export default function ChatPage() {
  const status = useChatStatus();
  return (
    <AdminOnly title="Chat">
      <PageHead
        title="Chat"
        about="Microsoft Teams and Slack: channels hear of the issues they’re subscribed to, and people report, find and change issues by talking to a4a’s bot, as themselves."
      />
      {status.isLoading ? <Loading what="chat" /> : null}
      {status.error ? <ErrorNote error={status.error} /> : null}
      {status.data ? (
        <>
          <div className="tw:grid tw:grid-cols-[repeat(auto-fit,minmax(min(100%,24rem),1fr))] tw:items-start tw:gap-x-4">
            <section className="card" aria-labelledby="chat-teams">
              <div className="section-head">
                <h2 id="chat-teams">Microsoft Teams</h2>
                {status.data.teams.configured ? <Badge tone="good">set up</Badge> : <Badge tone="idle">not set up</Badge>}
              </div>
              <Teams status={status.data} />
            </section>
            <section className="card" aria-labelledby="chat-slack">
              <div className="section-head">
                <h2 id="chat-slack">Slack</h2>
                {status.data.slack.connected ? <Badge tone="good">connected</Badge> : <Badge tone="idle">not connected</Badge>}
              </div>
              <Slack status={status.data} />
            </section>
          </div>
          <section className="card" aria-labelledby="chat-where">
            <div className="section-head">
              <h2 id="chat-where">What’s subscribed where</h2>
              <span className="note">A channel is told only what every reader of the project may see</span>
            </div>
            <Everywhere />
          </section>
        </>
      ) : null}
    </AdminOnly>
  );
}

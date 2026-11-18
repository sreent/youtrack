/**
 * Chat on the web (D42): channels' subscriptions, for a project and for administrators, and a
 * person's chat accounts on their profile.
 */
import type { ChatAccount, ChatChannel, ChatSubscription, Project } from '@a4a/shared';
import { CHAT_CHANGE_KINDS, CHAT_PLATFORM_NAMES, DEFAULT_CHAT_KINDS, type ChatChangeKind } from '@a4a/shared/constants';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { del, get, patch, post, qs } from '../../api/client';
import { agoSaid, Badge } from '../../components/Badges';
import { ErrorNote, Loading } from '../../components/States';
import { UserWho } from '../../components/Who';
import { errorText, FormField, Said, Scroll } from '../common/bits';
import { Confirm } from '../common/Confirm';
import { quoted } from '../common/format';
import { formatList, inSentence, problemWords, t, tr } from '../../i18n';
import type { ReactNode } from 'react';

/** What a channel hears of, by kind: the words a channel reads (chat/service.ts' aboutChannel). */
const KIND_WORDS: Record<ChatChangeKind, string> = {
  created: 'server.chat.kind.created',
  state: 'server.chat.kind.state',
  assigned: 'server.chat.kind.assigned',
  commented: 'server.chat.kind.commented',
  fields: 'server.chat.kind.fields',
};

/**
 * "New issues, state changes and comments in Backend": what a subscription tells its channel, in
 * the page's language. A channel is told it in the server's, and the API's `about` is English.
 */
export function aboutSubscription(s: Pick<ChatSubscription, 'kinds' | 'project' | 'search'>): string {
  const words = CHAT_CHANGE_KINDS.filter((k) => s.kinds.includes(k)).map((k) => t(KIND_WORDS[k]));
  const listed = words.length ? formatList(words) : t('server.chat.kind.nothing');
  const what = `${listed.charAt(0).toUpperCase()}${listed.slice(1)}`;
  return s.project ? t('server.chat.about.project', { what, project: s.project.name }) : t('server.chat.about.search', { what, search: s.search?.name ?? t('server.chat.about.aSavedSearch') });
}

export const chatKeys = {
  all: ['chat'] as const,
  status: ['chat', 'status'] as const,
  channels: ['chat', 'channels'] as const,
  subscriptions: (project?: string) => ['chat', 'subscriptions', project ?? '*'] as const,
  accounts: ['chat', 'accounts'] as const,
};

export const useChatChannels = () => useQuery({ queryKey: chatKeys.channels, queryFn: () => get<ChatChannel[]>('/chat/channels') });
export const useChatSubscriptions = (project?: string) =>
  useQuery({ queryKey: chatKeys.subscriptions(project), queryFn: () => get<ChatSubscription[]>(`/chat/subscriptions${qs({ project })}`) });
const useChatAccounts = () => useQuery({ queryKey: chatKeys.accounts, queryFn: () => get<ChatAccount[]>('/chat/accounts') });

export const KIND_NAMES: Record<ChatChangeKind, { name: string; about: string }> = {
  created: { name: t('chat.chat.newIssues'), about: t('chat.chat.eachIssueReportedInIt') },
  state: { name: t('chat.chat.stateChanges'), about: t('chat.chat.movedToAnotherState') },
  assigned: { name: t('chat.chat.assignments'), about: t('chat.chat.whoItSAssignedTo') },
  commented: { name: t('chat.chat.comments'), about: t('chat.chat.whatPeopleSayOnIt') },
  fields: { name: t('chat.chat.otherChanges'), about: t('chat.chat.itsOtherFieldsItsSummary') },
};

/** "#eng, Acme on Slack". */
export const channelName = (c: ChatChannel) => t('chat.chat.on2', { name: c.name, workspace: c.workspace, v: CHAT_PLATFORM_NAMES[c.platform] });

function KindChoices({ value, onChange, legend, disabled }: { value: ChatChangeKind[]; onChange: (v: ChatChangeKind[]) => void; legend: string; disabled?: boolean }) {
  return (
    <fieldset className="choice-group columns" disabled={disabled}>
      <legend>{legend}</legend>
      {CHAT_CHANGE_KINDS.map((k) => (
        <label key={k} className="choice">
          <input
            type="checkbox"
            checked={value.includes(k)}
            onChange={(e) => onChange(e.target.checked ? CHAT_CHANGE_KINDS.filter((x) => x === k || value.includes(x)) : value.filter((x) => x !== k))}
          />
          <span>
            {KIND_NAMES[k].name}
            <small className="field-help">{KIND_NAMES[k].about}</small>
          </span>
        </label>
      ))}
    </fieldset>
  );
}

/** What a change to a subscription did, said where a screen reader hears it. */
type SaidText = { text: string; bad?: boolean };

function SubscriptionRow({ s, showTarget, onSaid }: { s: ChatSubscription; showTarget: boolean; onSaid: (said: { text: string; bad?: boolean }) => void }) {
  const qc = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [kinds, setKinds] = useState<ChatChangeKind[]>(s.kinds);
  const refresh = () => void qc.invalidateQueries({ queryKey: chatKeys.all });
  const save = useMutation({
    mutationFn: () => patch<ChatSubscription>(`/chat/subscriptions/${s.id}`, { kinds }),
    onSuccess: (u) => {
      refresh();
      setEditing(false);
      onSaid({ text: t('chat.chat.hearsOf', { name: u.channel.name, what: inSentence(aboutSubscription(u)) }) });
    },
    onError: (e) => onSaid({ text: errorText(e), bad: true }),
  });
  const stop = useMutation({
    mutationFn: () => del(`/chat/subscriptions/${s.id}`),
    onSuccess: () => {
      refresh();
      onSaid({ text: s.ended ? t('chat.chat.takenOffTheList') : t('chat.chat.hearsOfItNoMore', { name: s.channel.name }) });
    },
    onError: (e) => onSaid({ text: errorText(e), bad: true }),
  });
  const target = s.project?.name ?? quoted(s.search?.name ?? t('chat.chat.aSavedSearch2'));
  return (
    <tr className={s.ended ? 'muted' : undefined}>
      <th scope="row" className="row-head">
        {/* Wide enough to read on a phone: the table scrolls in its frame rather than break words. */}
        <span className="tw:block tw:min-w-36">
          <span className="item-name">{s.channel.name}</span>
          <span className="item-about">
            {s.channel.workspace} · {CHAT_PLATFORM_NAMES[s.channel.platform]}
          </span>
        </span>
      </th>
      {showTarget ? <td>{s.project ? s.project.name : <>{tr('chat.chat.aSavedSearch', { target: target })}</>}</td> : null}
      <td>
        {editing ? (
          <form
            className="stack tight"
            onSubmit={(e) => {
              e.preventDefault();
              save.mutate();
            }}
          >
            <KindChoices value={kinds} onChange={setKinds} legend={t('chat.chat.whatHearsOf', { name: s.channel.name })} disabled={save.isPending} />
            <div className="cluster">
              <button type="submit" className="small primary" disabled={!kinds.length || save.isPending}>{t('chat.chat.save')}</button>
              <button type="button" className="small" onClick={() => setEditing(false)}>{t('chat.chat.cancel')}</button>
            </div>
          </form>
        ) : (
          <span className="tw:block tw:min-w-48">
            {aboutSubscription(s)}
            {s.ended ? (
              <span className="item-about">
                <Badge tone="idle">{t('chat.chat.stopped')}</Badge> {problemWords(s.ended.said) ?? s.ended.reason}
              </span>
            ) : null}
          </span>
        )}
      </td>
      <td>
        <span className="tw:block tw:min-w-36">
          <UserWho user={s.createdBy} small />
          <span className="item-about">{tr('chat.chat.subscribedIt', { when: agoSaid(s.createdAt) })}</span>
        </span>
      </td>
      <td className="fit">
        <div className="cluster">
          {!s.ended && !editing ? (
            <button type="button" className="small" onClick={() => setEditing(true)}>{tr('chat.chat.changeWhatHearsOf', { name: s.channel.name, t0: (c: ReactNode) => <span className="hidden">{c}</span> })}</button>
          ) : null}
          <Confirm
            small
            label={s.ended ? t('chat.chat.remove') : t('chat.chat.stop')}
            name={t('chat.chat.sSubscriptionTo', { v: s.ended ? t('chat.chat.remove') : t('chat.chat.stop'), name: s.channel.name, target: target })}
            title={s.ended ? t('chat.chat.takeSStoppedSubscriptionOff', { name: s.channel.name }) : t('chat.chat.stopTellingOf', { name: s.channel.name, target: target })}
            about={s.ended ? t('chat.chat.itPostsNothingAlready') : t('chat.chat.nothingMoreIsPostedThere')}
            confirm={s.ended ? t('chat.chat.removeIt') : t('chat.chat.stopIt')}
            disabled={stop.isPending}
            onConfirm={() => stop.mutate()}
          />
        </div>
      </td>
    </tr>
  );
}

/** Channels' subscriptions as a table: the channel, what it hears of, who vouches for it. */
export function ChatSubscriptionTable({
  subs,
  showTarget,
  label,
  onSaid,
}: {
  subs: ChatSubscription[];
  showTarget: boolean;
  label: string;
  /** Where to say what a row did, when the table itself may go (its last row stopped): else beneath it. */
  onSaid?: (said: SaidText) => void;
}) {
  const [said, setSaid] = useState<SaidText | null>(null);
  const tell = onSaid ?? setSaid;
  return (
    <div className="stack">
      <Scroll label={label}>
        <table className="figures middle">
          <thead>
            <tr>
              <th scope="col">{t('chat.chat.channel')}</th>
              {showTarget ? <th scope="col">{t('chat.chat.of')}</th> : null}
              <th scope="col">{t('chat.chat.itHearsOf')}</th>
              <th scope="col">{t('chat.chat.whoVouchesForIt')}</th>
              <th scope="col">
                <span className="hidden">{t('chat.chat.changeOrStop')}</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {subs.map((s) => (
              <SubscriptionRow key={s.id} s={s} showTarget={showTarget} onSaid={tell} />
            ))}
          </tbody>
        </table>
      </Scroll>
      {onSaid ? null : <Said text={said?.text} tone={said?.bad ? 'bad' : undefined} />}
    </div>
  );
}

/** Tell one of the channels a4a can post to of a project's issues. */
function AddChannel({ project }: { project: Project }) {
  const qc = useQueryClient();
  const channels = useChatChannels();
  const [channel, setChannel] = useState('');
  const [kinds, setKinds] = useState<ChatChangeKind[]>([...DEFAULT_CHAT_KINDS]);
  const [said, setSaid] = useState<{ text: string; bad?: boolean } | null>(null);
  const add = useMutation({
    mutationFn: () => post<ChatSubscription>('/chat/subscriptions', { channel, project: project.key, kinds }),
    onSuccess: (s) => {
      void qc.invalidateQueries({ queryKey: chatKeys.all });
      setChannel('');
      setSaid({ text: t('chat.chat.hearsOf', { name: s.channel.name, what: inSentence(aboutSubscription(s)) }) });
    },
    onError: (e) => setSaid({ text: errorText(e), bad: true }),
  });
  if (channels.isLoading) return <Loading what="loadingLine.channels" />;
  if (!channels.data?.length) {
    return <p className="note">{t('chat.chat.a4aCanPostToNo')}</p>;
  }
  return (
    <form
      className="form"
      onSubmit={(e) => {
        e.preventDefault();
        if (channel) add.mutate();
      }}
    >
      <FormField
        label={t('chat.chat.channel')}
        help={
          project.visibility === 'members'
            ? t('chat.chat.isOpenToItsMembers', { name: project.name })
            : t('chat.chat.itsPeopleSeeWhatEvery')
        }
      >
        {(id, help) => (
          <select id={id} aria-describedby={help} value={channel} onChange={(e) => setChannel(e.target.value)} required>
            <option value="">{t('chat.chat.chooseAChannel')}</option>
            {channels.data.map((c) => (
              <option key={c.id} value={c.id}>
                {channelName(c)}
              </option>
            ))}
          </select>
        )}
      </FormField>
      <KindChoices value={kinds} onChange={setKinds} legend={t('chat.chat.itHearsOf')} disabled={add.isPending} />
      <div className="cluster">
        <button type="submit" className="primary" disabled={!channel || !kinds.length || add.isPending}>
          {add.isPending ? t('chat.chat.subscribing') : t('chat.chat.tellTheChannel')}
        </button>
      </div>
      <Said text={said?.text} tone={said?.bad ? 'bad' : undefined} />
    </form>
  );
}

/** A project's page: the channels told of its issues, and telling another. */
export function ProjectChannels({ project, canAdd }: { project: Project; canAdd: boolean }) {
  const subs = useChatSubscriptions(project.key);
  // Said here, not in the table: stopping the last subscription takes the table away.
  const [said, setSaid] = useState<SaidText | null>(null);
  if (subs.isLoading) return <Loading what="loadingLine.projectChannels" />;
  if (subs.error || !subs.data) return <ErrorNote error={subs.error} />;
  return (
    <div className="stack">
      {subs.data.length ? (
        <ChatSubscriptionTable subs={subs.data} showTarget={false} label={t('chat.chat.tableOfTheChannelsTold', { name: project.name })} onSaid={setSaid} />
      ) : (
        <p className="note">{tr('chat.chat.noChannelHearsOfYet', { name: project.name })}</p>
      )}
      <Said text={said?.text} tone={said?.bad ? 'bad' : undefined} />
      {canAdd ? <AddChannel project={project} /> : null}
    </div>
  );
}

/** Your profile: the chat accounts that act as you, and unlinking one. */
export function ChatAccounts() {
  const qc = useQueryClient();
  const accounts = useChatAccounts();
  const [said, setSaid] = useState<{ text: string; bad?: boolean } | null>(null);
  const unlink = useMutation({
    mutationFn: (a: ChatAccount) => del(`/chat/accounts/${a.id}`).then(() => a),
    onSuccess: (a) => {
      void qc.invalidateQueries({ queryKey: chatKeys.accounts });
      setSaid({ text: t('chat.chat.onDoesnTActAs', { name: a.name, v: CHAT_PLATFORM_NAMES[a.platform] }) });
    },
    onError: (e) => setSaid({ text: errorText(e), bad: true }),
  });
  if (accounts.isLoading) return <Loading what="loadingLine.chatAccounts" />;
  if (accounts.error || !accounts.data) return <ErrorNote error={accounts.error} />;
  return (
    <div className="stack">
      {accounts.data.length ? (
        <ul className="plain" aria-label={t('chat.chat.yourChatAccounts')}>
          {accounts.data.map((a) => (
            <li key={a.id} className="cluster spread">
              <span>
                <span className="item-name">{tr('chat.chat.on', { name: a.name, v: CHAT_PLATFORM_NAMES[a.platform] })}</span>
                <span className="item-about">
                  {a.via === 'entra' ? t('chat.chat.teamsKnowsYouByYour') : t('chat.chat.linked', { workspace: a.workspace, when: agoSaid(a.linkedAt) })}
                </span>
              </span>
              {a.via === 'link' ? (
                <Confirm
                  small
                  label={t('chat.chat.unlink')}
                  name={t('chat.chat.unlinkOn2', { name: a.name, v: CHAT_PLATFORM_NAMES[a.platform] })}
                  title={t('chat.chat.unlinkOn', { name: a.name, v: CHAT_PLATFORM_NAMES[a.platform] })}
                  about={t('chat.chat.itStopsActingAsYou')}
                  confirm={t('chat.chat.unlinkIt')}
                  disabled={unlink.isPending}
                  onConfirm={() => unlink.mutate(a)}
                />
              ) : null}
            </li>
          ))}
        </ul>
      ) : (
        <p className="note">{t('chat.chat.noneYetSayLinkTo')}</p>
      )}
      <Said text={said?.text} tone={said?.bad ? 'bad' : undefined} />
    </div>
  );
}

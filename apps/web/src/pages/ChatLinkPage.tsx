import type { ChatAccount, ChatLink } from '@a4a/shared';
import { CHAT_PLATFORM_NAMES } from '@a4a/shared/constants';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useSearchParams } from 'react-router';
import { get, post } from '../api/client';
import { useMe } from '../api/queries';
import { ErrorNote, Loading, PageHead } from '../components/States';
import { chatKeys } from '../features/chat/Chat';
import { errorText, Said } from '../features/common/bits';

/** A sign-in link from the bot: who it would link, and linking it, by whoever signed in here. */
export default function ChatLinkPage() {
  const [params] = useSearchParams();
  const token = params.get('token') ?? '';
  const me = useMe();
  const qc = useQueryClient();
  const link = useQuery({ queryKey: ['chat', 'link', token], queryFn: () => get<ChatLink>(`/chat/links/${encodeURIComponent(token)}`), enabled: Boolean(token), retry: false });
  const accept = useMutation({
    mutationFn: () => post<ChatAccount>(`/chat/links/${encodeURIComponent(token)}`),
    onSuccess: () => void qc.invalidateQueries({ queryKey: chatKeys.accounts }),
  });
  if (!token) return <PageHead title="Link a chat account" about="This page takes a link from a4a’s bot in Teams or Slack. Say “link” to the bot to get one." />;
  if (link.isLoading) return <Loading what="the link" />;
  if (link.error || !link.data) {
    return (
      <>
        <PageHead title="Link a chat account" />
        <ErrorNote error={link.error} />
      </>
    );
  }
  const l = link.data;
  const where = CHAT_PLATFORM_NAMES[l.platform];
  if (accept.data) {
    return (
      <>
        <PageHead title="Linked" about={`${l.name} on ${where} acts as you in a4a now. You can go back to ${where}.`} />
        <p className="note">
          It’s on <Link to="/me">your profile</Link>, where you can unlink it.
        </p>
      </>
    );
  }
  return (
    <>
      <PageHead title={`Link your ${where} account`} about={`${where} asked a4a to act as you there. Link it only if it’s yours: whoever uses it acts as you.`} />
      <section className="card stack" aria-labelledby="chat-link">
        <h2 id="chat-link">
          {l.name} on {where}
        </h2>
        <dl className="facts-list">
          {l.workspace !== where ? (
            <div className="pair">
              <dt>In</dt>
              <dd>{l.workspace}</dd>
            </div>
          ) : null}
          <div className="pair">
            <dt>Acts as</dt>
            <dd>
              {me.data?.name} ({me.data?.login})
            </dd>
          </div>
          {l.linkedTo ? (
            <div className="pair">
              <dt>Now</dt>
              <dd>Linked to {l.linkedTo.name}: linking it moves it to you.</dd>
            </div>
          ) : null}
        </dl>
        <p className="note">The link works once, until {new Date(l.expiresAt).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}.</p>
        <div className="cluster">
          <button type="button" className="primary" disabled={accept.isPending} onClick={() => accept.mutate()}>
            {accept.isPending ? 'Linking…' : `Link it to ${me.data?.name ?? 'me'}`}
          </button>
          <Link to="/inbox">Not mine</Link>
        </div>
        <Said text={accept.error ? errorText(accept.error) : null} tone={accept.error ? 'bad' : undefined} />
      </section>
    </>
  );
}

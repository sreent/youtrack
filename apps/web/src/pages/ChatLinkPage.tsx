import type { ChatAccount, ChatLink } from '@a4a/shared';
import { CHAT_PLATFORM_NAMES } from '@a4a/shared/constants';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useSearchParams } from 'react-router';
import { get, post } from '../api/client';
import { useMe } from '../api/queries';
import { ErrorNote, Loading, PageHead } from '../components/States';
import { chatKeys } from '../features/chat/Chat';
import { errorText, Said } from '../features/common/bits';
import { intlLocale, t, tr } from '../i18n';
import type { ReactNode } from 'react';

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
  if (!token) return <PageHead title={t('page.chatLink.linkAChatAccount')} about={t('page.chatLink.thisPageTakesALink')} />;
  if (link.isLoading) return <Loading what="loadingLine.link" />;
  if (link.error || !link.data) {
    return (
      <>
        <PageHead title={t('page.chatLink.linkAChatAccount')} />
        <ErrorNote error={link.error} />
      </>
    );
  }
  const l = link.data;
  const where = CHAT_PLATFORM_NAMES[l.platform];
  if (accept.data) {
    return (
      <>
        <PageHead title={t('page.chatLink.linked')} about={t('page.chatLink.onActsAsYouIn', { name: l.name, where: where, where2: where })} />
        <p className="note">{tr('page.chatLink.itSOnYourProfile', { t0: (c: ReactNode) => <Link to="/me">{c}</Link> })}</p>
      </>
    );
  }
  return (
    <>
      <PageHead title={t('page.chatLink.linkYourAccount', { where: where })} about={t('page.chatLink.askedA4aToActAs', { where: where })} />
      <section className="card stack" aria-labelledby="chat-link">
        <h2 id="chat-link">{tr('page.chatLink.on', { name: l.name, where: where })}</h2>
        <dl className="facts-list">
          {l.workspace !== where ? (
            <div className="pair">
              <dt>{t('page.chatLink.in')}</dt>
              <dd>{l.workspace}</dd>
            </div>
          ) : null}
          <div className="pair">
            <dt>{t('page.chatLink.actsAs')}</dt>
            <dd>
              {me.data?.name} ({me.data?.login})
            </dd>
          </div>
          {l.linkedTo ? (
            <div className="pair">
              <dt>{t('page.chatLink.now')}</dt>
              <dd>{tr('page.chatLink.linkedToLinkingItMoves', { name: l.linkedTo.name })}</dd>
            </div>
          ) : null}
        </dl>
        <p className="note">{tr('page.chatLink.theLinkWorksOnceUntil', { toLocaleTimeString: new Date(l.expiresAt).toLocaleTimeString(intlLocale(), { hour: '2-digit', minute: '2-digit' }) })}</p>
        <div className="cluster">
          <button type="button" className="primary" disabled={accept.isPending} onClick={() => accept.mutate()}>
            {accept.isPending ? t('page.chatLink.linking') : me.data?.name ? t('page.chatLink.linkItToName', { name: me.data.name }) : t('page.chatLink.linkItToMe')}
          </button>
          <Link to="/inbox">{t('page.chatLink.notMine')}</Link>
        </div>
        <Said text={accept.error ? errorText(accept.error) : null} tone={accept.error ? 'bad' : undefined} />
      </section>
    </>
  );
}

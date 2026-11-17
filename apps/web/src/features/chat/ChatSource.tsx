import type { ChatIssueSource } from '@a4a/shared';
import { formatDateTime, t, tr } from '../../i18n';

/**
 * Where an issue made from a Teams or Slack message came from (D60), in the reader's words: the chat,
 * the channel and a link to the message, who sent it and when, the replies its description holds, and
 * the message's files, linked where the chat keeps them. Shown to whoever sees the issue.
 */
export function ChatSourceCard({ source }: { source: ChatIssueSource }) {
  const when = source.sentAt ? (
    <time dateTime={source.sentAt}>{formatDateTime(source.sentAt, { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })}</time>
  ) : null;
  return (
    <section className="card side-card stack" aria-labelledby="source-title">
      <h2 id="source-title">{t('page.issue.source.title')}</h2>
      <p>{t('page.issue.source.from', { platform: source.platform, channel: source.channel, workspace: source.workspace })}</p>
      <p className="note">{when ? tr('page.issue.source.sentBy', { author: source.author, when }) : t('page.issue.source.sentByUndated', { author: source.author })}</p>
      {source.url ? (
        <p>
          <a href={source.url} target="_blank" rel="noopener noreferrer">
            {t('page.issue.source.open', { platform: source.platform })}
          </a>
        </p>
      ) : null}
      {source.replies ? <p className="note">{t('page.issue.source.replies', { n: source.replies })}</p> : null}
      {source.files.length ? (
        <>
          <p className="note" id="source-files">
            {t('page.issue.source.files')}
          </p>
          <ul className="plain" aria-labelledby="source-files">
            {source.files.map((f, i) => (
              <li key={`${i}-${f.name}`}>
                {f.url ? (
                  <a href={f.url} target="_blank" rel="noopener noreferrer">
                    {f.name || new URL(f.url).pathname.split('/').pop()}
                  </a>
                ) : (
                  f.name
                )}
              </li>
            ))}
          </ul>
        </>
      ) : null}
      {source.moreFiles ? <p className="note">{t('page.issue.source.moreFiles', { n: source.moreFiles })}</p> : null}
      {source.cut ? <p className="note">{t('page.issue.source.cut')}</p> : null}
    </section>
  );
}

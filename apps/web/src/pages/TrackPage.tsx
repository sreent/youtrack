import type { TrackedRequest } from '@a4a/shared';
import { HELP_LIMITS } from '@a4a/shared/constants';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { ApiError, get, post } from '../api/client';
import { Lone } from '../app/Auth';
import { Badge } from '../components/Badges';
import { Markdown } from '../components/Markdown';
import { ErrorNote, Loading } from '../components/States';
import { Avatar } from '../components/Who';
import { FormField } from '../features/common/bits';
import { dateRead, whenRead } from '../features/common/format';
import { intlLocale, t, tr } from '../i18n';
import type { ReactNode } from 'react';

/** The token is in the address's fragment, which never leaves the browser; it travels to the API in a header. */
function tokenFromHash(): string {
  const token = window.location.hash.replace(/^#/, '').trim();
  // Only what could be a token is asked about: a link copied in part is said to be so here.
  return /^hdt_[A-Za-z0-9_-]{43}$/.test(token) ? token : '';
}

/** One help desk request, as the person who asked sees it: its state and its public conversation (Ocean's HelpDesk). */
export default function TrackPage() {
  const qc = useQueryClient();
  const [token, setToken] = useState(tokenFromHash);
  useEffect(() => {
    const on = () => setToken(tokenFromHash());
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  const headers = { 'x-tracking-token': token };
  const request = useQuery({
    queryKey: ['tracked', token],
    queryFn: () => get<TrackedRequest>('/help/requests/by-token', { headers }),
    enabled: Boolean(token),
    retry: false,
  });
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  useEffect(() => {
    if (request.data) document.title = request.data.summary;
  }, [request.data]);

  if (!token || request.error) {
    const missing = !token || (request.error instanceof ApiError && request.error.status === 404);
    return (
      <Lone wide>
        <h1>{missing ? t('page.track.thisLinkDoesnTOpen') : t('page.track.yourRequestDidnTLoad')}</h1>
        {missing ? <p className="note">{t('page.track.useTheLinkInYour')}</p> : <ErrorNote error={request.error} />}
      </Lone>
    );
  }
  if (request.isLoading || !request.data) {
    return (
      <Lone wide>
        <Loading what="loadingLine.yourRequest" />
      </Lone>
    );
  }
  const r = request.data;
  const reply = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!text.trim()) return;
    setBusy(true);
    setError(null);
    try {
      qc.setQueryData(['tracked', token], await post<TrackedRequest>('/help/requests/by-token/replies', { text }, { headers }));
      setText('');
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Lone wide>
      <p className="label">{tr('page.track.helpDesk', { name: r.project.name })}</p>
      <div className="title-row">
        <h1>{r.summary}</h1>
        {r.state.name ? <Badge tone={r.state.resolved ? 'good' : null}>{r.state.name}</Badge> : null}
      </div>
      <p className="note">{tr('page.track.youAskedOnAs', { dateRead: dateRead(r.createdAt.slice(0, 10)), t0: (c: ReactNode) => <time dateTime={r.createdAt}>{c}</time>, name: r.requester.name, email: r.requester.email })}</p>
      <ol className="history" aria-label={t('page.track.yourRequestAndTheReplies')}>
        <li>
          <Avatar kind="person" name={r.requester.name} small />
          <div className="history-body">
            <p className="history-head">{tr('page.track.youAsked', { t0: (c: ReactNode) => <strong className="who-name">{c}</strong>, whenRead: whenRead(r.createdAt), t1: (c: ReactNode) => <time dateTime={r.createdAt} title={new Date(r.createdAt).toLocaleString(intlLocale())}>{c}</time> })}</p>
            {r.description.trim() ? (
              <div className="history-comment">
                <Markdown text={r.description} outside />
              </div>
            ) : null}
          </div>
        </li>
        {r.messages.map((m) => (
          <li key={m.id}>
            <Avatar kind="person" name={m.from === 'you' ? r.requester.name : m.name} small />
            <div className="history-body">
              <p className="history-head">
                {tr('page.track.messageHead', {
                  name: m.from === 'you' ? t('page.track.you') : m.name,
                  from: m.from /* a stable code */,
                  whenRead: whenRead(m.at),
                  t0: (c: ReactNode) => <strong className="who-name">{c}</strong>,
                  t1: (c: ReactNode) => (
                    <time dateTime={m.at} title={new Date(m.at).toLocaleString(intlLocale())}>
                      {c}
                    </time>
                  ),
                })}
              </p>
              <div className="history-comment">
                <Markdown text={m.text} outside />
              </div>
            </div>
          </li>
        ))}
      </ol>
      {!r.messages.some((m) => m.from === 'team') ? <p className="note">{t('page.track.noReplyYetTheTeam')}</p> : null}
      <form className="form" onSubmit={reply}>
        <FormField label={t('page.track.yourReply')} help={r.emailMuted ? t('page.track.youStoppedEmailsAboutThis') : t('page.track.weLlEmailYouWhen')}>
          {(id, help) => <textarea id={id} rows={4} value={text} onChange={(e) => setText(e.target.value)} maxLength={HELP_LIMITS.reply} aria-describedby={help} />}
        </FormField>
        {error ? <ErrorNote error={error} /> : null}
        <div className="cluster end">
          <button type="submit" className="primary" disabled={!text.trim() || busy}>
            {busy ? t('page.track.sending') : t('page.track.sendTheReply')}
          </button>
        </div>
      </form>
    </Lone>
  );
}

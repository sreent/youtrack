import type { HelpdeskRequest, RequestCc } from '@a4a/shared';
import { HELP_LIMITS } from '@a4a/shared/constants';
import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { del, post, qs } from '../../api/client';
import { keys } from '../../api/queries';
import { Who } from '../../components/Who';
import { errorText, FormField, Said } from '../common/bits';
import { whenRead } from '../common/format';
import { inboxKeys } from '../notifications/api';
import { t } from '../../i18n';

/** How someone came to be copied, and when: by the team, from the requester's email, or by them on the portal. */
function how(c: RequestCc, requester: string): string {
  const when = whenRead(c.addedAt);
  if (c.via === 'email') return t('helpdesk.requestCcs.byEmail', { requester, when });
  if (c.via === 'portal') return t('helpdesk.requestCcs.byPortal', { requester, when });
  return t('helpdesk.requestCcs.byTeam', { name: c.addedBy?.name ?? '', when });
}

/**
 * Who is copied on a help desk request (D57): each told of its public replies and changes of state
 * by email, as its requester is, and able to answer by email. Whoever may change the issue copies
 * people and stops copying them; each change is in its history.
 */
export function RequestCcs({ issue, r, canEdit }: { issue: string; r: HelpdeskRequest; canEdit: boolean }) {
  const qc = useQueryClient();
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [said, setSaid] = useState<{ text: string; bad?: boolean } | null>(null);
  const done = (ccs: RequestCc[]) => {
    qc.setQueryData<HelpdeskRequest | null>(inboxKeys.request(issue), (old) => (old ? { ...old, ccs } : old));
    void qc.invalidateQueries({ queryKey: keys.issueSub(issue, 'activity') });
    // Copying someone held settles their hold (D67): the request says so when it's read again.
    if (r.held.length) void qc.invalidateQueries({ queryKey: inboxKeys.request(issue) });
  };
  const copy = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy('add');
    setSaid(null);
    try {
      const who = email.trim();
      done(await post<RequestCc[]>(`/issues/${issue}/request/ccs`, { email: who, ...(name.trim() ? { name: name.trim() } : {}) }));
      setEmail('');
      setName('');
      setSaid({ text: t('helpdesk.requestCcs.nowCopied', { email: who }) });
    } catch (err) {
      setSaid({ text: errorText(err), bad: true });
    } finally {
      setBusy(null);
    }
  };
  const stop = async (c: RequestCc) => {
    setBusy(c.email);
    setSaid(null);
    try {
      await del(`/issues/${issue}/request/ccs${qs({ email: c.email })}`);
      done(r.ccs.filter((x) => x.email !== c.email));
      setSaid({ text: t('helpdesk.requestCcs.noLongerCopied', { email: c.email }) });
    } catch (err) {
      setSaid({ text: errorText(err), bad: true });
    } finally {
      setBusy(null);
    }
  };
  return (
    <section className="stack tight" aria-labelledby="request-ccs-title">
      <h3 id="request-ccs-title">{t('helpdesk.requestCcs.copied')}</h3>
      {r.ccs.length ? (
        <ul className="plain stack tight">
          {r.ccs.map((c) => (
            <li key={c.email} className="stack tight">
              <Who kind="person" name={c.name || c.email} about={c.name ? c.email : undefined} small />
              <p className="note">{how(c, r.requester.name)}</p>
              {canEdit ? (
                <div className="cluster">
                  <button type="button" className="link" aria-label={t('helpdesk.requestCcs.stopCopyingWho', { email: c.email })} disabled={busy !== null} onClick={() => void stop(c)}>
                    {t('helpdesk.requestCcs.stopCopying')}
                  </button>
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      ) : (
        <p className="note">{t('helpdesk.requestCcs.nobody')}</p>
      )}
      {r.ccs.length >= r.ccsMax ? <p className="note">{t('helpdesk.requestCcs.full', { max: r.ccsMax })}</p> : null}
      {r.held.length ? (
        // Whom the email that opened it named, waiting for its requester (D67): told nothing until then.
        <div className="stack tight">
          <h4>{t('helpdesk.requestCcs.held', { requester: r.requester.name })}</h4>
          <p className="note">{t('helpdesk.requestCcs.heldNote', { requester: r.requester.name })}</p>
          <ul className="plain stack tight">
            {r.held.map((h) => (
              <li key={h.email}>
                <Who kind="person" name={h.name || h.email} about={h.name ? h.email : undefined} small />
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {canEdit ? (
        <form className="form" onSubmit={copy} aria-label={t('helpdesk.requestCcs.copySomeone')}>
          <FormField label={t('helpdesk.requestCcs.theirEmail')}>
            {(id) => <input id={id} type="email" required autoComplete="off" maxLength={HELP_LIMITS.email} value={email} onChange={(e) => setEmail(e.target.value)} />}
          </FormField>
          <FormField label={t('helpdesk.requestCcs.theirName')}>{(id) => <input id={id} autoComplete="off" maxLength={HELP_LIMITS.name} value={name} onChange={(e) => setName(e.target.value)} />}</FormField>
          <div className="cluster end">
            <button type="submit" disabled={busy !== null || !email.trim()}>
              {busy === 'add' ? t('helpdesk.requestCcs.copying') : t('helpdesk.requestCcs.copy')}
            </button>
          </div>
        </form>
      ) : null}
      {said ? <Said text={said.text} tone={said.bad ? 'bad' : undefined} /> : null}
    </section>
  );
}

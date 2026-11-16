import type { HelpdeskInbound, HelpdeskInboundOutcome, HelpdeskMail as Mail, HelpdeskMailSecret, Project } from '@a4a/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { del, get, post, put } from '../../api/client';
import { Badge, IssueLink } from '../../components/Badges';
import { ErrorNote, Loading } from '../../components/States';
import { errorText, FormField, Said, Scroll } from '../common/bits';
import { Confirm } from '../common/Confirm';
import { CopyButton } from '../common/CopyButton';
import { whenRead } from '../common/format';
import { t, tr } from '../../i18n';
import type { ReactNode } from 'react';

const mailKeys = {
  mail: (key: string) => ['helpdesk-mail', key] as const,
  log: (key: string) => ['helpdesk-mail', key, 'log'] as const,
};

/** What became of a message, with its shape: filed or answered went well; set aside stood still; refused or failed, a cross. */
const OUTCOME: Record<HelpdeskInboundOutcome, { tone?: 'good' | 'idle' | 'bad' | 'warn'; word: string }> = {
  received: { tone: 'warn', word: 'being handled' },
  request: { tone: 'good', word: 'a new request' },
  reply: { tone: 'good', word: 'a reply' },
  ignored: { tone: 'idle', word: 'set aside' },
  refused: { tone: 'bad', word: 'refused' },
  failed: { tone: 'bad', word: 'failed' },
};

function Secret({ made, onKept }: { made: HelpdeskMailSecret; onKept: () => void }) {
  return (
    <div className="secret" role="status">
      <p>{tr('helpdesk.helpdeskMail.copyTheAddressNowIt', { t0: (c: ReactNode) => <strong>{c}</strong> })}</p>
      <code>{made.url}</code>
      <div className="cluster">
        <CopyButton text={made.url} label={t('helpdesk.helpdeskMail.copyTheAddress')} what={t('helpdesk.helpdeskMail.theAddress')} />
        <CopyButton text={made.secret} label={t('helpdesk.helpdeskMail.copyTheSecretAlone')} what={t('helpdesk.helpdeskMail.theSecret')} />
        <button type="button" className="link" onClick={onKept}>{t('helpdesk.helpdeskMail.iVeKeptIt')}</button>
      </div>
      <ul>
        <li>{t('helpdesk.helpdeskMail.sendgridInboundParseTickPost')}</li>
        <li>{t('helpdesk.helpdeskMail.mailgunARouteThatForwards')}</li>
        <li>{t('helpdesk.helpdeskMail.postmarkAnInboundWebhookWith')}</li>
        <li>{t('helpdesk.helpdeskMail.anythingElseSuchAsA')}</li>
      </ul>
    </div>
  );
}

function Log({ projectKey }: { projectKey: string }) {
  const log = useQuery({ queryKey: mailKeys.log(projectKey), queryFn: () => get<HelpdeskInbound[]>(`/projects/${projectKey}/helpdesk/mail/log`), refetchInterval: 30_000 });
  if (log.isLoading) return <Loading what={t('helpdesk.helpdeskMail.whatCameIn2')} />;
  if (log.error) return <ErrorNote error={log.error} />;
  if (!log.data?.length) return <p className="note">{t('helpdesk.helpdeskMail.nothingHasComeInYet')}</p>;
  return (
    <Scroll label={t('helpdesk.helpdeskMail.tableOfWhatCameIn')}>
      <table className="figures">
        <thead>
          <tr>
            <th scope="col">{t('helpdesk.helpdeskMail.when')}</th>
            <th scope="col">{t('helpdesk.helpdeskMail.message')}</th>
            <th scope="col">{t('helpdesk.helpdeskMail.whatBecameOfIt')}</th>
          </tr>
        </thead>
        <tbody>
          {log.data.map((m) => (
            <tr key={m.id}>
              <td>
                <time dateTime={m.at} title={m.at}>
                  {whenRead(m.at)}
                </time>
              </td>
              <td>
                {m.subject || <span className="note">{t('helpdesk.helpdeskMail.noSubject')}</span>}
                <span className="item-about">{tr('helpdesk.helpdeskMail.from', { v: m.sender || 'nobody', t0: (c: ReactNode) => <span className="mono">{c}</span>, v2: m.via === 'imap' ? 'read from the mailbox' : 'posted by the provider' })}</span>
              </td>
              <td>
                <Badge tone={OUTCOME[m.outcome].tone}>{OUTCOME[m.outcome].word}</Badge> {m.issue ? <IssueLink id={m.issue} /> : null}
                {m.reason && m.outcome !== 'request' ? <span className="item-about">{m.reason}</span> : null}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </Scroll>
  );
}

/**
 * A help desk's mail, for its managers (D30): the address people write to, how its mail comes in
 * (a provider's webhook, the server's shared mailbox, or both), and what came in.
 */
export function HelpdeskMail({ project }: { project: Project }) {
  const qc = useQueryClient();
  const mail = useQuery({ queryKey: mailKeys.mail(project.key), queryFn: () => get<Mail>(`/projects/${project.key}/helpdesk/mail`) });
  const [address, setAddress] = useState('');
  const [said, setSaid] = useState<{ text: string; bad?: boolean } | null>(null);
  const [made, setMade] = useState<HelpdeskMailSecret | null>(null);
  const saved = mail.data?.address ?? '';
  useEffect(() => setAddress(saved), [saved]);
  const refresh = (m: Mail) => qc.setQueryData(mailKeys.mail(project.key), m);
  const save = useMutation({
    mutationFn: (value: string | null) => put<Mail>(`/projects/${project.key}/helpdesk/mail`, { address: value }),
    onSuccess: (m) => {
      refresh(m);
      setSaid({ text: m.address ? t('helpdesk.helpdeskMail.savedMailToComesHere', { address: m.address }) : t('helpdesk.helpdeskMail.savedTheDeskTakesNo') });
    },
    onError: (e) => setSaid({ text: errorText(e), bad: true }),
  });
  const secret = useMutation({
    mutationFn: () => post<HelpdeskMailSecret>(`/projects/${project.key}/helpdesk/mail/secret`),
    onSuccess: (s) => {
      setMade(s);
      setSaid(null);
      void qc.invalidateQueries({ queryKey: mailKeys.mail(project.key) });
    },
    onError: (e) => setSaid({ text: errorText(e), bad: true }),
  });
  const stop = useMutation({
    mutationFn: () => del(`/projects/${project.key}/helpdesk/mail/secret`),
    onSuccess: () => {
      setMade(null);
      setSaid({ text: t('helpdesk.helpdeskMail.theWebhookTakesNothingNow') });
      void qc.invalidateQueries({ queryKey: mailKeys.mail(project.key) });
    },
    onError: (e) => setSaid({ text: errorText(e), bad: true }),
  });

  if (mail.isLoading) return <Loading what={t('helpdesk.helpdeskMail.itsMail')} />;
  if (mail.error || !mail.data) return <ErrorNote error={mail.error} />;
  const m = mail.data;
  const dirty = address.trim() !== saved;
  return (
    <div className="stack">
      <form
        className="form"
        onSubmit={(e) => {
          e.preventDefault();
          save.mutate(address.trim() || null);
        }}
      >
        <FormField label={t('helpdesk.helpdeskMail.theDeskSAddress')} help={t('helpdesk.helpdeskMail.wherePeopleWriteSuchAs')}>
          {(id, help) => (
            <input id={id} type="email" className="mono" value={address} onChange={(e) => setAddress(e.target.value)} placeholder="support@acme.example" aria-describedby={help} maxLength={254} />
          )}
        </FormField>
        <div className="cluster">
          <button type="submit" className="primary" disabled={!dirty || save.isPending}>
            {save.isPending ? t('helpdesk.helpdeskMail.saving') : t('helpdesk.helpdeskMail.saveTheAddress')}
          </button>
          {saved ? (
            <Confirm
              small
              label={t('helpdesk.helpdeskMail.takeNoMail')}
              title={t('helpdesk.helpdeskMail.stopTakingMailAt', { saved: saved })}
              about={t('helpdesk.helpdeskMail.mailToItNoLonger')}
              confirm={t('helpdesk.helpdeskMail.takeNoMail')}
              disabled={save.isPending}
              onConfirm={() => save.mutate(null)}
            />
          ) : null}
        </div>
      </form>
      <Said text={said?.text} tone={said?.bad ? 'bad' : undefined} />

      {m.address ? (
        <>
          <p className="note">{tr('helpdesk.helpdeskMail.eachEmailA4aSendsA', { code: <code>{m.replyAddress}</code>, round: Math.round(m.maxBytes / 1024 / 1024) })}</p>
          <div className="stack tight">
            <h3>{t('helpdesk.helpdeskMail.fromYourMailProvider')}</h3>
            <div className="cluster">
              <span className="note">{t('helpdesk.helpdeskMail.itPostsTo')}</span>
              <code className="hook-url">{m.inbound.url}</code>
              {m.inbound.secretPrefix ? (
                <Badge tone="good">{tr('helpdesk.helpdeskMail.takesPostsWithTheSecret', { secretPrefix: m.inbound.secretPrefix, t0: (c: ReactNode) => <span className="mono">{c}</span> })}</Badge>
              ) : (
                <Badge tone="idle">{t('helpdesk.helpdeskMail.takesNoneYet')}</Badge>
              )}
            </div>
            <div className="cluster">
              {m.inbound.secretPrefix ? (
                <>
                  <Confirm
                    small
                    label={t('helpdesk.helpdeskMail.giveItANewSecret')}
                    title={t('helpdesk.helpdeskMail.giveTheWebhookANew')}
                    about={t('helpdesk.helpdeskMail.theOldOneStopsWorking')}
                    confirm={t('helpdesk.helpdeskMail.makeANewOne')}
                    disabled={secret.isPending}
                    onConfirm={() => secret.mutate()}
                  />
                  <Confirm
                    small
                    label={t('helpdesk.helpdeskMail.stopTheWebhook')}
                    title={t('helpdesk.helpdeskMail.stopTakingMailFromThe')}
                    about={t('helpdesk.helpdeskMail.a4aRefusesWhatItPosts')}
                    confirm={t('helpdesk.helpdeskMail.stopIt')}
                    disabled={stop.isPending}
                    onConfirm={() => stop.mutate()}
                  />
                </>
              ) : (
                <button type="button" onClick={() => secret.mutate()} disabled={secret.isPending}>
                  {secret.isPending ? t('helpdesk.helpdeskMail.makingIt') : t('helpdesk.helpdeskMail.makeItsSecret')}
                </button>
              )}
            </div>
            {made ? <Secret made={made} onKept={() => setMade(null)} /> : null}
          </div>
          <div className="stack tight">
            <h3>{t('helpdesk.helpdeskMail.fromTheSharedMailbox')}</h3>
            <p className="note">
              {m.imap.configured
                ? t('helpdesk.helpdeskMail.thisServerReadsMailThere', { server: m.imap.server, address: m.address })
                : t('helpdesk.helpdeskMail.thisServerReadsNoMailbox')}
            </p>
          </div>
          <div className="stack tight">
            <h3>{t('helpdesk.helpdeskMail.whatCameIn')}</h3>
            <Log projectKey={project.key} />
          </div>
        </>
      ) : (
        <p className="note">{t('helpdesk.helpdeskMail.giveTheDeskAnAddress')}</p>
      )}
    </div>
  );
}

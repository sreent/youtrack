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
      <p>
        <strong>Copy the address now.</strong> It holds the secret, and this is the only time a4a shows it. Give it to your mail provider as where it posts each
        message it gets for this desk, raw.
      </p>
      <code>{made.url}</code>
      <div className="cluster">
        <CopyButton text={made.url} label="Copy the address" what="the address" />
        <CopyButton text={made.secret} label="Copy the secret alone" what="the secret" />
        <button type="button" className="link" onClick={onKept}>
          I've kept it
        </button>
      </div>
      <ul>
        <li>SendGrid Inbound Parse: tick “POST the raw, full MIME message”.</li>
        <li>Mailgun: a route that forwards to this address, with the MIME version of each message.</li>
        <li>Postmark: an inbound webhook with “Include raw email content” on.</li>
        <li>Anything else, such as a Cloudflare Email Worker: post the message as it came, as message/rfc822, with the secret as the password.</li>
      </ul>
    </div>
  );
}

function Log({ projectKey }: { projectKey: string }) {
  const log = useQuery({ queryKey: mailKeys.log(projectKey), queryFn: () => get<HelpdeskInbound[]>(`/projects/${projectKey}/helpdesk/mail/log`), refetchInterval: 30_000 });
  if (log.isLoading) return <Loading what="what came in" />;
  if (log.error) return <ErrorNote error={log.error} />;
  if (!log.data?.length) return <p className="note">Nothing has come in yet. What does, and what becomes of it, shows here for 30 days.</p>;
  return (
    <Scroll label="Table of what came in by email">
      <table className="figures">
        <thead>
          <tr>
            <th scope="col">When</th>
            <th scope="col">Message</th>
            <th scope="col">What became of it</th>
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
                {m.subject || <span className="note">(no subject)</span>}
                <span className="item-about">
                  from <span className="mono">{m.sender || 'nobody'}</span>, {m.via === 'imap' ? 'read from the mailbox' : 'posted by the provider'}
                </span>
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
      setSaid({ text: m.address ? `Saved. Mail to ${m.address} comes here.` : 'Saved. The desk takes no mail now.' });
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
      setSaid({ text: 'The webhook takes nothing now. Mail from the shared mailbox still comes.' });
      void qc.invalidateQueries({ queryKey: mailKeys.mail(project.key) });
    },
    onError: (e) => setSaid({ text: errorText(e), bad: true }),
  });

  if (mail.isLoading) return <Loading what="its mail" />;
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
        <FormField label="The desk's address" help="Where people write, such as support@acme.example. a4a answers them from it, and their answers come back here.">
          {(id, help) => (
            <input id={id} type="email" className="mono" value={address} onChange={(e) => setAddress(e.target.value)} placeholder="support@acme.example" aria-describedby={help} maxLength={254} />
          )}
        </FormField>
        <div className="cluster">
          <button type="submit" className="primary" disabled={!dirty || save.isPending}>
            {save.isPending ? 'Saving…' : 'Save the address'}
          </button>
          {saved ? (
            <Confirm
              small
              label="Take no mail"
              title={`Stop taking mail at ${saved}?`}
              about="Mail to it no longer reaches the desk, and the webhook's secret is forgotten. Requests already in keep their pages."
              confirm="Take no mail"
              disabled={save.isPending}
              onConfirm={() => save.mutate(null)}
            />
          ) : null}
        </div>
      </form>
      <Said text={said?.text} tone={said?.bad ? 'bad' : undefined} />

      {m.address ? (
        <>
          <p className="note">
            Each email a4a sends a requester answers from an address of its own, such as <code>{m.replyAddress}</code>, so an answer finds its request. Your mail server must
            deliver addresses with a “+” to the same mailbox, as Google, Microsoft and most others do. Messages up to {Math.round(m.maxBytes / 1024 / 1024)} MB.
          </p>
          <div className="stack tight">
            <h3>From your mail provider</h3>
            <div className="cluster">
              <span className="note">It posts to</span>
              <code className="hook-url">{m.inbound.url}</code>
              {m.inbound.secretPrefix ? (
                <Badge tone="good">
                  takes posts with the secret <span className="mono">{m.inbound.secretPrefix}…</span>
                </Badge>
              ) : (
                <Badge tone="idle">takes none yet</Badge>
              )}
            </div>
            <div className="cluster">
              {m.inbound.secretPrefix ? (
                <>
                  <Confirm
                    small
                    label="Give it a new secret"
                    title="Give the webhook a new secret?"
                    about="The old one stops working at once: until the provider has the new address, a4a refuses what it posts."
                    confirm="Make a new one"
                    disabled={secret.isPending}
                    onConfirm={() => secret.mutate()}
                  />
                  <Confirm
                    small
                    label="Stop the webhook"
                    title="Stop taking mail from the provider?"
                    about="a4a refuses what it posts from now on. The address and the shared mailbox are unchanged."
                    confirm="Stop it"
                    disabled={stop.isPending}
                    onConfirm={() => stop.mutate()}
                  />
                </>
              ) : (
                <button type="button" onClick={() => secret.mutate()} disabled={secret.isPending}>
                  {secret.isPending ? 'Making it…' : 'Make its secret'}
                </button>
              )}
            </div>
            {made ? <Secret made={made} onKept={() => setMade(null)} /> : null}
          </div>
          <div className="stack tight">
            <h3>From the shared mailbox</h3>
            <p className="note">
              {m.imap.configured
                ? `This server reads ${m.imap.server}. Mail there to ${m.address} comes to this desk.`
                : 'This server reads no mailbox. Its administrator can set HELPDESK_IMAP_URL to one; mail there to this address would come here too.'}
            </p>
          </div>
          <div className="stack tight">
            <h3>What came in</h3>
            <Log projectKey={project.key} />
          </div>
        </>
      ) : (
        <p className="note">Give the desk an address, and people can ask by email as well as on its form, and answer the team's emails.</p>
      )}
    </div>
  );
}

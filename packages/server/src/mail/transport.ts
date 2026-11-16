/**
 * Sending one message: nodemailer over SMTP, from SMTP_URL. Everything else about mail (what to
 * send, when, retries) is the outbox's (mail/outbox.ts), so a transport only sends or fails.
 */
import nodemailer from 'nodemailer';

export interface OutgoingMail {
  from: string;
  to: string;
  subject: string;
  text: string;
  html: string;
  /** Stable across retries ("<n-123@host>"), so a message sent twice reads as one. */
  messageId: string;
  headers: Record<string, string>;
}

export interface MailTransport {
  send(mail: OutgoingMail): Promise<void>;
  close?(): void;
}

/** A failure that retrying won't fix, such as a mailbox that doesn't exist (an SMTP 5xx). */
export class PermanentMailError extends Error {}

export function createSmtpTransport(url: string): MailTransport {
  // A sender holds its claim on a mail for two minutes (mail/outbox.ts), so a send gives up well before.
  const transporter = nodemailer.createTransport({ url, connectionTimeout: 20_000, greetingTimeout: 20_000, socketTimeout: 60_000 });
  return {
    async send(mail) {
      try {
        await transporter.sendMail({
          from: mail.from,
          to: mail.to,
          subject: mail.subject,
          text: mail.text,
          html: mail.html,
          messageId: mail.messageId,
          headers: mail.headers,
        });
      } catch (e) {
        const code = (e as { responseCode?: number }).responseCode;
        if (typeof code === 'number' && code >= 500 && code < 600) throw new PermanentMailError((e as Error).message);
        throw e;
      }
    },
    close: () => transporter.close(),
  };
}

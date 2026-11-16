/**
 * Help desk mail, as specs arrange it (D30): a desk given an address and its webhook a secret, and
 * messages posted the way a mail provider posts them: raw, with the secret as HTTP Basic's
 * password, and no cookie or token of anyone's.
 */
import type { HelpdeskMailSecret } from '@a4a/shared';
import { expect } from '@playwright/test';
import type { Api } from './api';

/** Open a project's help desk, give it an address, and make its webhook's secret. */
export async function deskTakingMail(api: Api, key: string, address: string): Promise<HelpdeskMailSecret> {
  await api.patch(`/projects/${key}`, { settings: { helpdesk: { enabled: true } } });
  const res = await api.context.put(`/api/v1/projects/${key}/helpdesk/mail`, { data: { address } });
  expect(res.ok(), `PUT the desk's address: ${res.status()} ${await res.text()}`).toBe(true);
  return api.post<HelpdeskMailSecret>(`/projects/${key}/helpdesk/mail/secret`);
}

let serial = 0;

/** A plain email, as a mail client sends one. */
export function message(opts: { from: string; to: string; subject: string; body: string; headers?: string[] }): string {
  return [
    `From: ${opts.from}`,
    `To: ${opts.to}`,
    `Subject: ${opts.subject}`,
    `Date: ${new Date().toUTCString()}`,
    `Message-ID: <e2e.${Date.now().toString(36)}.${++serial}.${Math.random().toString(36).slice(2)}@mail.example.com>`,
    ...(opts.headers ?? []),
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=utf-8',
    '',
    ...opts.body.split('\n'),
    '',
  ].join('\r\n');
}

/** Post a message to the address a4a showed (the secret in it), as a mail provider does. */
export async function postMail(webhookUrl: string, raw: string): Promise<{ status: number; body: unknown }> {
  const url = new URL(webhookUrl);
  const auth = Buffer.from(`${decodeURIComponent(url.username)}:${decodeURIComponent(url.password)}`).toString('base64');
  url.username = '';
  url.password = '';
  const res = await fetch(url, { method: 'POST', headers: { authorization: `Basic ${auth}`, 'content-type': 'message/rfc822' }, body: raw });
  return { status: res.status, body: await res.json() };
}

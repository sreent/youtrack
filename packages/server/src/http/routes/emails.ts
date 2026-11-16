import type { OpenAPIHono } from '@hono/zod-openapi';
import {
  AddEmailBody,
  ConfirmEmailBody,
  EmailLinkSchema,
  PersonEmailsSchema,
  PrimaryEmailBody,
  ProviderLoginBody,
  ProviderLoginSchema,
  SendEmailLinkBody,
} from '@a4a/shared';
import { z } from 'zod';
import { addEmailFor, addMyEmail, confirmEmail, emailLink, makePrimary, personEmails, removeEmailFor, removeMyEmail, sendEmailLink } from '../../services/emails';
import { addProviderLogin, listProviderLogins, removeProviderLogin } from '../../vcs/logins';
import type { HttpEnv } from '../env';
import { route } from '../route';

const Id = z.object({ id: z.string() });

/** A person's emails, and their logins at version control providers (D33). */
export function emailRoutes(app: OpenAPIHono<HttpEnv>) {
  const tags = ['Emails and logins'];
  route(app, { method: 'get', path: '/me/emails', tags, summary: 'Your emails: the primary one first, each confirmed or not', response: PersonEmailsSchema }, ({ ctx }) =>
    personEmails(ctx, ctx.actor.user.id),
  );
  route(
    app,
    {
      method: 'post',
      path: '/me/emails',
      tags,
      summary: 'Add an email; a link to confirm it goes to it',
      description:
        'Once it\'s confirmed, commits under it are yours: they link as yours, and the commands in them run as you. The link works once, for 24 hours, opened by you signed in. Without email set up here (no SMTP), an administrator confirms it. Signed in only, never with a token.',
      body: AddEmailBody,
      response: PersonEmailsSchema,
      status: 200,
    },
    ({ ctx, body }) => addMyEmail(ctx, body.email),
  );
  route(
    app,
    { method: 'post', path: '/me/emails/send', tags, summary: 'Send the link again to one of your emails that waits to be confirmed', body: SendEmailLinkBody, response: PersonEmailsSchema, status: 200 },
    ({ ctx, body }) => sendEmailLink(ctx, body.email),
  );
  route(
    app,
    {
      method: 'get',
      path: '/me/emails/confirm',
      tags,
      summary: 'Which email a link confirms, without confirming it',
      query: z.object({ token: z.string().min(16).max(200) }),
      response: EmailLinkSchema,
    },
    ({ ctx, query }) => emailLink(ctx, query.token),
  );
  route(
    app,
    {
      method: 'post',
      path: '/me/emails/confirm',
      tags,
      summary: 'Confirm an email with the link a4a mailed to it',
      description: 'Only the person who added the email can: the link is theirs alone.',
      body: ConfirmEmailBody,
      response: EmailLinkSchema,
      status: 200,
    },
    ({ ctx, body }) => confirmEmail(ctx, body.token),
  );
  route(
    app,
    { method: 'post', path: '/me/emails/primary', tags, summary: 'Make one of your confirmed emails the primary one', body: PrimaryEmailBody, response: PersonEmailsSchema, status: 200 },
    ({ ctx, body }) => makePrimary(ctx, body.email),
  );
  route(app, { method: 'delete', path: '/me/emails/{id}', tags, summary: 'Remove one of your other emails', params: Id, status: 204 }, async ({ ctx, params }) => {
    await removeMyEmail(ctx, params.id);
    return null;
  });

  route(app, { method: 'get', path: '/users/{id}/emails', tags, summary: "Someone's emails (admin, or your own)", params: Id, response: PersonEmailsSchema }, ({ ctx, params }) =>
    personEmails(ctx, params.id),
  );
  route(
    app,
    {
      method: 'post',
      path: '/users/{id}/emails',
      tags,
      summary: 'Add a confirmed email for someone (admin)',
      description: 'An administrator vouches for it, so it counts at once. A confirmed email is one person\'s: one someone else has confirmed is refused.',
      params: Id,
      body: AddEmailBody,
      response: PersonEmailsSchema,
      status: 200,
    },
    ({ ctx, params, body }) => addEmailFor(ctx, params.id, body.email),
  );
  route(
    app,
    { method: 'delete', path: '/users/{id}/emails/{emailId}', tags, summary: "Remove one of someone's other emails (admin)", params: z.object({ id: z.string(), emailId: z.string() }), status: 204 },
    async ({ ctx, params }) => {
      await removeEmailFor(ctx, params.id, params.emailId);
      return null;
    },
  );

  route(
    app,
    {
      method: 'get',
      path: '/users/{id}/provider-logins',
      tags,
      summary: "Someone's logins at version control providers (admin, or your own)",
      params: Id,
      response: z.array(ProviderLoginSchema),
    },
    ({ ctx, params }) => listProviderLogins(ctx, params.id),
  );
  route(
    app,
    {
      method: 'post',
      path: '/users/{id}/provider-logins',
      tags,
      summary: "Record someone's login at a version control provider (admin)",
      description:
        'A commit or pull request the provider says that account wrote is theirs, as one under a confirmed email is. GitHub, Gitea and Bitbucket name the account they matched a commit\'s email to; GitLab names none for a commit, only for a merge request. For Bitbucket Cloud give the account id or UUID: its nicknames aren\'t unique.',
      params: Id,
      body: ProviderLoginBody,
      response: ProviderLoginSchema,
    },
    ({ ctx, params, body }) => addProviderLogin(ctx, params.id, body),
  );
  route(
    app,
    {
      method: 'delete',
      path: '/users/{id}/provider-logins/{loginId}',
      tags,
      summary: "Forget someone's login at a provider (admin)",
      params: z.object({ id: z.string(), loginId: z.string() }),
      status: 204,
    },
    async ({ ctx, params }) => {
      await removeProviderLogin(ctx, params.id, params.loginId);
      return null;
    },
  );
}

import type { OpenAPIHono } from '@hono/zod-openapi';
import { AbsenceQuery, AbsenceSchema, CreateAbsenceBody, PreferencesSchema, UpdateAbsenceBody, UpdatePreferencesBody } from '@a4a/shared';
import { z } from 'zod';
import { createAbsence, deleteAbsence, getPreferences, listAbsences, updateAbsence, updatePreferences } from '../../services/absences';
import type { HttpEnv } from '../env';
import { route } from '../route';

const Id = z.object({ id: z.string() });

/** Days away (docs/architecture.md, D36), and what each person chose to see. */
export function absenceRoutes(app: OpenAPIHono<HttpEnv>) {
  const tags = ['Days away'];
  route(
    app,
    {
      method: 'get',
      path: '/absences',
      tags,
      summary: "Someone's days away",
      description:
        'Whole days, or a morning or afternoon (`half`). Anyone may see when someone is away; why (`kind`, `note`) only the person, administrators and whoever entered it: to anyone else they are null. By default from a month ago on.',
      query: AbsenceQuery,
      response: z.array(AbsenceSchema),
    },
    ({ ctx, query }) => listAbsences(ctx, query),
  );
  route(
    app,
    {
      method: 'post',
      path: '/absences',
      tags,
      summary: 'Enter days away',
      description:
        "Your own, or, as a manager of a project someone works in or as an administrator, theirs (`user`). Plans then skip those days for the person's work. A year at most; a half day is one day; days that overlap others of theirs are refused (409), naming them.",
      body: CreateAbsenceBody,
      response: AbsenceSchema,
    },
    ({ ctx, body }) => createAbsence(ctx, body),
  );
  route(
    app,
    {
      method: 'patch',
      path: '/absences/{id}',
      tags,
      summary: 'Change days away',
      description: 'Only what is sent changes; a half day moved onto several days becomes whole days. Send `expectedVersion` to get 409 rather than overwrite a change made since.',
      params: Id,
      body: UpdateAbsenceBody,
      response: AbsenceSchema,
    },
    ({ ctx, params, body }) => updateAbsence(ctx, params.id, body),
  );
  route(app, { method: 'delete', path: '/absences/{id}', tags, summary: 'Remove days away', params: Id, status: 204 }, async ({ ctx, params }) => {
    await deleteAbsence(ctx, params.id);
    return null;
  });

  route(app, { method: 'get', path: '/me/preferences', tags: ['Auth'], summary: 'What you chose to see, kept for you across devices', response: PreferencesSchema }, ({ ctx }) =>
    getPreferences(ctx),
  );
  route(
    app,
    {
      method: 'patch',
      path: '/me/preferences',
      tags: ['Auth'],
      summary: 'Choose what you see',
      description: "`loadWindow`: the load grid's days on every plan, `{ \"preset\": \"2w\" | \"1m\" | \"3m\" | \"plan\" }` from today, or `{ \"from\", \"to\" }`; null for the plan's own. What isn't sent stays as it was.",
      body: UpdatePreferencesBody,
      response: PreferencesSchema,
    },
    ({ ctx, body }) => updatePreferences(ctx, body),
  );
}

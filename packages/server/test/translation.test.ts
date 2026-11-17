/**
 * a4a in each person's language (D49): an email in its recipient's, the language on /me, the server's
 * default, and a problem's key beside its English.
 */
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LOCALES } from '@a4a/shared/i18n';
import de from '@a4a/shared/i18n/de.json' with { type: 'json' };
import en from '@a4a/shared/i18n/en.json' with { type: 'json' };
import type { UserRow } from '../src/context';
import { users } from '../src/db/schema';
import { OutboxWorker } from '../src/events/worker';
import { createHttpApp } from '../src/http/app';
import { localeOfPerson, translatorFor } from '../src/i18n';
import { MailWorker } from '../src/mail/outbox';
import { notifierConsumer } from '../src/notify/notifier';
import { prepareQuery } from '../src/search/service';
import { emailTime } from '../src/notify/words';
import { createIssue } from '../src/services/issues';
import { createProject } from '../src/services/projects';
import { insertUser } from '../src/services/users';
import { createWorld, type TestWorld } from './helpers';
import { fakeSmtp, type FakeSmtp } from './smtp';

let w: TestWorld;
let smtp: FakeSmtp;
let lena: UserRow;
let sam: UserRow;
let app: ReturnType<typeof createHttpApp>;

async function call(method: string, path: string, opts: { body?: unknown; cookie?: string } = {}) {
  const res = await app.request(`/api/v1${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...(opts.cookie ? { cookie: opts.cookie, origin: 'http://a4a.test' } : {}) },
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  return { status: res.status, body: (await res.json().catch(() => null)) as any, cookie: res.headers.get('set-cookie')?.split(';')[0] ?? '' };
}

beforeAll(async () => {
  smtp = await fakeSmtp(0);
  w = await createWorld({ config: { smtpUrl: smtp.url, notifyWindowMs: 0, publicUrl: 'http://a4a.test' } });
  app = createHttpApp(w.app);
  await createProject(w.adminCtx, { key: 'SPR', name: 'Sprachen', template: 'software' });
  lena = await insertUser(w.app.db, { login: 'lena', name: 'Lena Vogel', email: 'lena@example.com', password: 'lena-password-1', role: 'member' });
  sam = await insertUser(w.app.db, { login: 'sam', name: 'Sam Reed', email: 'sam@example.com', role: 'member' });
  await w.app.db.update(users).set({ locale: 'de', timeZone: 'Europe/Berlin' }).where(eq(users.id, lena.id));
  lena = (await w.app.db.select().from(users).where(eq(users.id, lena.id)))[0]!;
  w.app.schema.invalidate();
});

afterAll(async () => {
  await w?.close();
  await smtp?.close();
});

describe('a4a in each person’s language (D49)', () => {
  it('says a query in the language its page asks for, and in English to an agent or a script', async () => {
    const query = 'project: SPR #Unresolved for: me sort by: updated desc';
    const page = await prepareQuery({ ...w.as(lena), pageLocale: 'de' }, query);
    expect(page.explanation).toBe('Vorgänge: im Projekt SPR, unerledigt und Ihnen zugewiesen, sortiert nach updated (absteigend)');
    // Lena reads a4a in German, but what a script of hers reads is the API's words: English.
    const script = await prepareQuery(w.as(lena), query);
    expect(script.explanation).toBe('Issues in project SPR, unresolved, assigned to you sorted by updated (descending)');
    // In pieces too, for the line on the page that counts what it found.
    expect(page.explained).toEqual({ body: 'im Projekt SPR, unerledigt und Ihnen zugewiesen', sort: ', sortiert nach updated (absteigend)', zone: null });
    expect(script.explained).toEqual({ body: 'in project SPR, unresolved, assigned to you', sort: ' sorted by updated (descending)', zone: null });
  });

  it('counts what a search found in each language, saying its noun once', async () => {
    const line = async (locale: (typeof LOCALES)[number], query: string, n: number) => {
      const { explained } = await prepareQuery({ ...w.as(lena), pageLocale: locale }, query);
      const t = translatorFor(locale).t;
      const found = explained.body ? t('issues.queryBar.foundWhere', { n, ...explained }) : explained.sort ? t('issues.queryBar.foundSorted', { n, ...explained }) : t('issues.queryBar.foundRecentFirst', { n });
      return explained.zone ? t('issues.queryBar.foundDatesIn', { found, zone: explained.zone }) : found;
    };
    const said = async (query: string, n: number) => Object.fromEntries(await Promise.all(LOCALES.map(async (l) => [l, await line(l, query, n)])));
    expect(await said('project: SPR #Unresolved', 4)).toEqual({
      en: '4 issues in project SPR, unresolved',
      de: '4 Vorgänge: im Projekt SPR und unerledigt',
      es: 'Incidencias del proyecto SPR y sin resolver: 4',
      fr: 'Tickets dans le projet SPR, non résolus : 4',
      ja: '4件の課題：プロジェクト：SPR、未解決',
    });
    expect(await said('sort by: Priority', 1)).toEqual({
      en: '1 issue sorted by Priority',
      de: '1 Vorgang, sortiert nach Priority',
      es: 'Todas las incidencias ordenadas por Priority: 1',
      fr: 'Tous les tickets, triés par Priority : 1',
      ja: '1件の課題、並び順：Priority',
    });
    expect(await said('', 0)).toEqual({
      en: '0 issues (most recently updated first)',
      de: '0 Vorgänge (zuletzt aktualisierte zuerst)',
      es: 'Todas las incidencias (primero las actualizadas más recientemente): 0',
      fr: 'Tous les tickets (les plus récemment mis à jour d’abord) : 0',
      ja: '0件の課題（最近更新された順）',
    });
    // Lena reads dates in Berlin. "created today" is the query language's, as written.
    expect((await said('created: today', 2)).de).toBe('2 Vorgänge: created today (Datumsangaben in Europe/Berlin)');
  });

  it('has a catalog for every language it speaks, with every English message in it', () => {
    expect(LOCALES).toContain('de');
    expect(Object.keys(de).sort()).toEqual(Object.keys(en).sort());
  });

  it('emails each person in their own language, with dates in it', async () => {
    const outbox = new OutboxWorker(w.app, [notifierConsumer(w.app)], {}, [], () => {});
    const mailer = new MailWorker(w.app, () => new Date(Date.now() + 10 * 60_000));
    await outbox.drain();
    await mailer.drain();
    smtp.messages.length = 0;
    await createIssue(w.adminCtx, { project: 'SPR', summary: 'Für Lena', fields: { Assignee: 'lena' } });
    await createIssue(w.adminCtx, { project: 'SPR', summary: 'For Sam', fields: { Assignee: 'sam' } });
    await outbox.drain();
    await mailer.drain();
    await outbox.stop();

    const german = smtp.messages.find((m) => m.to.includes('lena@example.com'));
    expect(german?.text).toContain('Ada Admin hat ihn gemeldet und Ihnen zugewiesen');
    expect(german?.text).toContain('Sie erhalten dies, weil der Vorgang Ihnen zugewiesen wurde.');
    expect(german?.text).not.toContain('assigned it to you');
    // A German date, where she is: "Mo., 16. Nov." rather than "Mon 16 Nov".
    expect(emailTime('2026-11-16T22:30:00.000Z', 'Europe/Berlin', 'de')).toMatch(/^Mo\.?,? 16\. Nov\.?,? 23:30/);
    expect(german?.text).toContain(emailTime(new Date().toISOString(), 'Europe/Berlin', 'de').slice(0, 4));

    const english = smtp.messages.find((m) => m.to.includes('sam@example.com'));
    expect(english?.text).toContain('assigned it to you');
    expect(english?.text).toContain('You get this because it was assigned to you.');
  });

  it('keeps a person’s language on /me, else none, with the server’s default beside it', async () => {
    const login = await call('POST', '/auth/login', { body: { login: 'lena', password: 'lena-password-1' } });
    expect(login.status).toBe(200);
    const me = await call('GET', '/me', { cookie: login.cookie });
    expect(me.body).toMatchObject({ locale: 'de', defaultLocale: 'en' });
    const cleared = await call('PATCH', '/me', { cookie: login.cookie, body: { locale: null } });
    expect(cleared.body.locale).toBeNull();
    expect(localeOfPerson(w.app, { ...lena, locale: null })).toBe('en');
    const refused = await call('PATCH', '/me', { cookie: login.cookie, body: { locale: 'xx' } });
    expect(refused.status).toBe(400);
    const back = await call('PATCH', '/me', { cookie: login.cookie, body: { locale: 'de' } });
    expect(back.body.locale).toBe('de');
    expect(localeOfPerson(w.app, sam)).toBe('en');
  });

  it('gives a problem its key and values beside the English, for a page to say it in its language', async () => {
    const wrong = await call('POST', '/auth/login', { body: { login: 'lena', password: 'not her password' } });
    expect(wrong.status).toBe(401);
    expect(wrong.body.error).toMatchObject({ code: 'unauthorized', message: 'Wrong login or password', key: 'wrongLogin' });
    expect(translatorFor('de').t(`problem.${wrong.body.error.key}`)).toBe('Login oder Passwort ist falsch.');
    const invalid = await call('POST', '/auth/login', { body: { login: 'lena' } });
    expect(invalid.body.error).toMatchObject({ code: 'validation_failed', key: 'validationFailed' });
    // Every key a problem can carry is in every catalog.
    for (const key of ['unauthorized', 'forbidden', 'aiDisabled', 'validationFailed', 'alreadyExists', 'stillReferenced', 'internal', 'tokenUnknown', 'rateLimited', 'tooLarge', 'passwordLoginOff', 'tooManySignIns', 'wrongLogin', 'tooManyCodes']) {
      expect(en).toHaveProperty(`problem.${key}`);
      expect(de).toHaveProperty(`problem.${key}`);
    }
  });

  it('falls back to English for a key a catalog lacks, and to the key itself for one nobody has', () => {
    const tr = translatorFor('de');
    expect(tr.t('server.mail.openInbox')).toBe('Posteingang öffnen');
    expect(translatorFor('xx').locale).toBe('en');
    expect(tr.t('no.such.key')).toBe('no.such.key');
  });
});

/**
 * a4a in each person's language (D49): an email in its recipient's, the language on /me, the server's
 * default, and a problem's key beside its English.
 */
import type { TrackerEvent } from '@a4a/shared';
import { desc, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTranslator, koreanParticles, LOCALES, sayProblem, type ProblemSaid } from '@a4a/shared/i18n';
import de from '@a4a/shared/i18n/de.json' with { type: 'json' };
import en from '@a4a/shared/i18n/en.json' with { type: 'json' };
import ja from '@a4a/shared/i18n/ja.json' with { type: 'json' };
import zh from '@a4a/shared/i18n/zh.json' with { type: 'json' };
import { runCommand } from '../src/commands/executor';
import type { UserRow } from '../src/context';
import { activities, users } from '../src/db/schema';
import { OutboxWorker } from '../src/events/worker';
import { createHttpApp } from '../src/http/app';
import { localeOfPerson, problemFor, translatorFor } from '../src/i18n';
import { AppError } from '../src/lib/errors';
import { MailWorker } from '../src/mail/outbox';
import { notifierConsumer } from '../src/notify/notifier';
import { prepareQuery } from '../src/search/service';
import { emailTime, eventDetail } from '../src/notify/words';
import { addFieldValue, attachField, createField } from '../src/services/fields';
import { createIssue, updateIssue } from '../src/services/issues';
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
      id: '4 isu di proyek SPR, belum selesai',
      ja: '4件の課題：プロジェクト：SPR、未解決',
      zh: '4 个问题：项目 SPR、未解决',
      ko: '이슈 4개: 프로젝트 SPR 및 미해결',
      pt: 'Itens no projeto SPR, não resolvidos: 4',
      vi: '4 vấn đề trong dự án SPR, chưa giải quyết',
      th: 'อิชชู 4 รายการ ในโปรเจกต์ SPR และที่ยังไม่ปิด',
    });
    expect(await said('sort by: Priority', 1)).toEqual({
      en: '1 issue sorted by Priority',
      de: '1 Vorgang, sortiert nach Priority',
      es: 'Todas las incidencias ordenadas por Priority: 1',
      fr: 'Tous les tickets, triés par Priority : 1',
      id: '1 isu, diurutkan menurut Priority',
      ja: '1件の課題、並び順：Priority',
      zh: '1 个问题，按 Priority 排序',
      ko: '이슈 1개, 정렬: Priority',
      pt: 'Todos os itens ordenados por Priority: 1',
      vi: '1 vấn đề, sắp xếp theo Priority',
      th: 'อิชชู 1 รายการ เรียงตาม Priority',
    });
    expect(await said('', 0)).toEqual({
      en: '0 issues (most recently updated first)',
      de: '0 Vorgänge (zuletzt aktualisierte zuerst)',
      es: 'Todas las incidencias (primero las actualizadas más recientemente): 0',
      fr: 'Tous les tickets (les plus récemment mis à jour d’abord) : 0',
      id: '0 isu (yang terakhir diperbarui lebih dulu)',
      ja: '0件の課題（最近更新された順）',
      zh: '0 个问题（按最近更新排序）',
      ko: '이슈 0개 (최근 업데이트순)',
      pt: 'Todos os itens (os atualizados mais recentemente primeiro): 0',
      vi: '0 vấn đề (mới cập nhật xếp trước)',
      th: 'อิชชู 0 รายการ (อัปเดตล่าสุดก่อน)',
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

  it('chooses a Korean particle by the word before it, where a4a can read its end', () => {
    // A Hangul word by its last syllable's final consonant, ㄹ apart before (으)로; a number as Korean reads it.
    expect(koreanParticles('BACK-12을(를) 옮겼습니다')).toBe('BACK-12를 옮겼습니다');
    expect(koreanParticles('BACK-10을(를) 옮겼습니다')).toBe('BACK-10을 옮겼습니다');
    expect(koreanParticles('김민준이(가) 댓글을 남겼습니다')).toBe('김민준이 댓글을 남겼습니다');
    expect(koreanParticles('안나은(는) 담당자입니다')).toBe('안나는 담당자입니다');
    expect(koreanParticles('서울(으)로, 부산(으)로, 7(으)로')).toBe('서울로, 부산으로, 7로');
    expect(koreanParticles('사과(이)라는 값, 책(이)라는 값')).toBe('사과라는 값, 책이라는 값');
    expect(koreanParticles('“완료”과(와) “진행”과(와)')).toBe('“완료”와 “진행”과');
    // A Latin word's end a4a can't hear: both ways stay.
    expect(koreanParticles('Anna을(를) 보았습니다')).toBe('Anna을(를) 보았습니다');
    // Through a translator: plain words, a count, and a name inside a tag.
    const ko = createTranslator('ko', { saw: '{name}을(를) 보았습니다', moved: '{n, plural, other {이슈 #개}}을(를) 옮겼습니다', bold: '<b>{name}</b>을(를) 보았습니다' });
    expect(ko.t('saw', { name: '민수' })).toBe('민수를 보았습니다');
    expect(ko.t('moved', { n: 3 })).toBe('이슈 3개를 옮겼습니다');
    expect(ko.parts('bold', { name: '민준', b: (c: unknown[]) => ({ b: c }) })).toEqual([{ b: ['민준'] }, '을 보았습니다']);
    // Only Korean: another language's brackets are its own.
    expect(createTranslator('en', { x: '{name}을(를)' }).t('x', { name: '민수' })).toBe('민수을(를)');
  });

  it('elides French’s words before a value that begins with a vowel’s sound, and only there', () => {
    const fr = translatorFor('fr');
    // A name with a vowel, one with an h (kept: a4a can't tell a mute one from an aspirated one), an acronym, a number.
    expect(fr.t('agents.agentAccounts.tokensOf', { login: 'anna' })).toBe('Jetons d’anna');
    expect(fr.t('agents.agentAccounts.tokensOf', { login: 'ben' })).toBe('Jetons de ben');
    expect(fr.t('articles.articleTree.sKnowledgeBase', { name: 'Hélène' })).toBe('Base de connaissances de Hélène');
    expect(fr.t('apps.projectApps.appsIn', { project: 'API' })).toBe('Applications d’API');
    expect(fr.t('apps.projectApps.appsIn', { project: 'SQL' })).toBe('Applications de SQL');
    expect(fr.t('ui.badges.onDate', { date: '8 déc.' })).toBe('le 8 déc.');
    expect(fr.t('activity.ledgerEntry.throughTheApiAs', { name: 'Ada Admin' })).toBe('via l’API, en tant qu’Ada Admin');
    // A value that is one of the catalog's own messages, by its first word.
    expect(fr.t('apps.projectApps.appsIn', { project: fr.t('roles.builtin.guest') })).toBe(`Applications d’${fr.t('roles.builtin.guest')}`);
  });

  it('drops the space Chinese puts beside a value where the value is written in Chinese, on either side', () => {
    const zhT = translatorFor('zh');
    expect(zhT.t('activity.ledgerEntry.fromChatAs', { name: '王芳' })).toBe('来自聊天，以王芳身份');
    expect(zhT.t('activity.ledgerEntry.fromChatAs', { name: 'Ada Admin' })).toBe('来自聊天，以 Ada Admin 身份');
    expect(zhT.t('activity.ledgerEntry.fromAs', { v: 'Slack', name: '李明' })).toBe('来自 Slack，以李明身份');
    // Before a value only, and after one only.
    expect(zhT.t('activity.ledgerEntry.fromChatAs', { name: 'Ada 王' })).toBe('来自聊天，以 Ada 王身份');
    expect(zhT.t('activity.ledgerEntry.fromChatAs', { name: '王 Ada' })).toBe('来自聊天，以王 Ada 身份');
    expect(zhT.t('server.notify.title.assigned', { who: '王芳' })).toBe('王芳把此问题指派给了你');
    expect(zhT.t('server.notify.title.assigned', { who: 'Ada' })).toBe('Ada 把此问题指派给了你');
  });

  it('passes a problem’s list as a list, which each language joins as it joins items', async () => {
    const tried = await createIssue(w.adminCtx, { project: 'SPR', summary: 'Ohne Feld', fields: { Nope: 'x' } }).catch((e: unknown) => e);
    expect(tried).toBeInstanceOf(AppError);
    const e = tried as AppError;
    expect(e.words?.key).toBe('issues.noSuchField');
    const names = e.words?.values?.names as string[];
    expect(Array.isArray(names) && names.length).toBeGreaterThan(2);
    // The API's English joins them as English does.
    expect(e.hint).toBe(`Fields: ${names.join(', ')}`);
    expect(problemFor(translatorFor('ja'), e)).toContain(names.join('、'));
    expect(problemFor(translatorFor('zh'), e)).toContain(names.join('、'));
    expect(problemFor(translatorFor('de'), e)).toContain(names.join(', '));
    // Over HTTP, for a page to say it again from its key, in its own language.
    const admin = await call('POST', '/auth/login', { body: { login: 'admin', password: 'password-admin' } });
    const res = await call('POST', '/issues', { cookie: admin.cookie, body: { project: 'SPR', summary: 'Ohne Feld', fields: { Nope: 'x' } } });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatchObject({ key: 'issues.noSuchField', values: { names } });
    const said = (messages: Record<string, string>, locale: 'ja' | 'zh') => sayProblem(createTranslator(locale, messages), { key: res.body.error.key, values: res.body.error.values } as ProblemSaid);
    expect(said(ja, 'ja')).toContain(names.join('、'));
    expect(said(zh, 'zh')).toContain(names.join('、'));
    expect(said(ja, 'ja')).not.toContain(', ');
  });

  it('joins two fields a command’s value could be of with Intl’s list: Spanish’s “e” before an “i” sound', async () => {
    for (const name of ['Impacto', 'Importancia']) {
      const field = await createField(w.adminCtx, { name, type: 'enum', multi: false, description: '', values: [] });
      await attachField(w.adminCtx, 'SPR', field.id, {});
      await addFieldValue(w.adminCtx, field.id, { name: 'Alta' });
    }
    w.app.schema.invalidate();
    const issue = await createIssue(w.adminCtx, { project: 'SPR', summary: 'Zwei Felder' });
    const { problems } = await runCommand(w.adminCtx, { issues: [issue.id], command: 'Alta', dryRun: true });
    const p = problems.find((x) => x.key === 'command.valueOfFields');
    expect(p?.message).toMatch(/^"Alta" is a value of (Impacto and Importancia|Importancia and Impacto)$/);
    expect(p?.values?.fields).toMatchObject({ and: expect.arrayContaining(['Impacto', 'Importancia']) });
    const es = sayProblem(translatorFor('es'), { key: p!.key!, values: p!.values } as ProblemSaid);
    expect(es).toMatch(/es un valor de (Impacto e Importancia|Importancia e Impacto)\./);
    expect(es).not.toMatch(/ y I/);
  });

  it('keeps each value of a change to the tags, for a page and an email to join in their language', async () => {
    const issue = await createIssue(w.adminCtx, { project: 'SPR', summary: 'Mit Tags' });
    await updateIssue(w.adminCtx, issue.id, { addTags: ['alpha', 'beta'] });
    const [row] = await w.app.db.select().from(activities).where(eq(activities.type, 'issue.updated')).orderBy(desc(activities.id)).limit(1);
    const event = { type: row!.type, ...(row!.payload as object) } as TrackerEvent;
    const tags = event.changes.find((c) => c.field === 'Tags');
    expect(tags).toMatchObject({ from: null, to: 'alpha, beta', toList: ['alpha', 'beta'] });
    expect(eventDetail(translatorFor('ja'), event).join('\n')).toContain('alpha、beta');
    expect(eventDetail(translatorFor('en'), event).join('\n')).toContain('alpha, beta');
  });
});

/**
 * What the translator does at a value's edge (D49): French elides a word before a value that begins
 * with a vowel's sound, Chinese drops the space it puts beside a value written in Chinese, and a list
 * among a message's values is joined as its reader's language joins one.
 */
import { describe, expect, it } from 'vitest';
import en from '../i18n/en.json' with { type: 'json' };
import es from '../i18n/es.json' with { type: 'json' };
import ja from '../i18n/ja.json' with { type: 'json' };
import zh from '../i18n/zh.json' with { type: 'json' };
import th from '../i18n/th.json' with { type: 'json' };
import { canSayProblem, createTranslator, frenchElides, isListSaid, joinItems, joinList, sayProblem, squareAt, type ProblemSaid, matchLocale } from '../src/i18n';

const b = (chunks: unknown[]) => ({ b: chunks });

describe('French elides before a value', () => {
  const fr = createTranslator('fr', {
    of: 'Jetons de {name}',
    the: 'Il manque le {name}.',
    as: 'en tant que {name}',
    start: 'De {name} à Ben',
    if: 'Dites-le si {who} veut.',
    until: 'jusque {when}',
    code: 'Code {name}',
    own: 'Le planning de Ada, le onze.',
    bold: 'Builds de <b>{project}</b> depuis {from}',
    count: 'Fichiers de {n}',
    what: 'Il parle de {what}.',
    error: 'une erreur',
    yes: 'oui',
  });
  const of = (name: string) => fr.t('of', { name });

  it('elides de, le, que and their like before a vowel, keeping the word’s capital', () => {
    expect(of('Ada')).toBe('Jetons d’Ada');
    expect(of('anna')).toBe('Jetons d’anna');
    expect(of('Émile')).toBe('Jetons d’Émile');
    expect(of('Ilse Weber')).toBe('Jetons d’Ilse Weber');
    expect(of('Ben')).toBe('Jetons de Ben');
    expect(fr.t('the', { name: 'Assignee' })).toBe('Il manque l’Assignee.');
    expect(fr.t('as', { name: 'Ana' })).toBe('en tant qu’Ana');
    expect(fr.t('start', { name: 'Ada' })).toBe('D’Ada à Ben');
    expect(fr.t('until', { when: 'aujourd’hui' })).toBe('jusqu’aujourd’hui');
  });

  it('keeps de before an h, mute or aspirated, which a4a can’t tell apart', () => {
    expect(of('Hélène')).toBe('Jetons de Hélène');
    expect(of('HubSpot')).toBe('Jetons de HubSpot');
  });

  it('reads an acronym by its first letter, and y by the sound it makes', () => {
    expect(fr.t('the', { name: 'API' })).toBe('Il manque l’API.');
    expect(of('iOS')).toBe('Jetons d’iOS');
    expect(of('SQL')).toBe('Jetons de SQL');
    expect(of('Yves')).toBe('Jetons d’Yves');
    expect(of('Yann')).toBe('Jetons de Yann');
    expect(of('YAML')).toBe('Jetons de YAML');
  });

  it('keeps de before a number, and before what doesn’t begin with a letter', () => {
    expect(fr.t('count', { n: 8 })).toBe('Fichiers de 8');
    expect(fr.t('count', { n: 11 })).toBe('Fichiers de 11');
    expect(of('« Ada »')).toBe('Jetons de « Ada »');
    expect(of('@ada')).toBe('Jetons de @ada');
  });

  it('elides si before il and ils alone', () => {
    expect(fr.t('if', { who: 'il' })).toBe('Dites-le s’il veut.');
    expect(fr.t('if', { who: 'ils' })).toBe('Dites-le s’ils veut.');
    expect(fr.t('if', { who: 'Ilse' })).toBe('Dites-le si Ilse veut.');
    expect(fr.t('if', { who: 'Ada' })).toBe('Dites-le si Ada veut.');
  });

  it('elides before a value that is one of the catalog’s messages, by its first word', () => {
    expect(fr.t('what', { what: fr.t('error') })).toBe('Il parle d’une erreur.');
    expect(fr.t('what', { what: fr.t('yes') })).toBe('Il parle de oui.');
    expect(frenchElides('de', 'onze tickets')).toBe(false);
  });

  it('acts only at a value’s edge: the catalog’s own words stay as its translators wrote them', () => {
    expect(fr.t('own')).toBe('Le planning de Ada, le onze.');
    expect(fr.t('code', { name: 'Ada' })).toBe('Code Ada');
  });

  it('elides before a value a tag holds, leaving what the tag made whole', () => {
    expect(fr.parts('bold', { project: 'ACME', from: 'GitHub', b })).toEqual(['Builds d’', { b: ['ACME'] }, ' depuis GitHub']);
    expect(fr.parts('bold', { project: 'BACK', from: 'GitHub', b })).toEqual(['Builds de ', { b: ['BACK'] }, ' depuis GitHub']);
  });

  it('leaves other languages’ words alone', () => {
    expect(createTranslator('en', { of: 'Jetons de {name}' }).t('of', { name: 'Ada' })).toBe('Jetons de Ada');
    expect(createTranslator('es', { of: 'Tokens de {name}' }).t('of', { name: 'Ada' })).toBe('Tokens de Ada');
  });
});

describe('Chinese spaces a value in Latin letters or digits, not one in Chinese', () => {
  const zhT = createTranslator('zh', {
    as: '以 {name} 身份',
    by: '由 {name} 创建',
    first: '{name} 评论了 {issue}',
    days: '{name} 3 天',
    two: '{a} {b}',
    quoted: '已添加 {name}。',
    tag: '<b>{v}</b> 提交了请求',
    inside: '<b>以 {name} 身份</b> 登录',
    count: '{n, plural, other {{name} 有 # 个问题}}',
  });

  it('drops the space on the side where a value begins or ends in Chinese', () => {
    expect(zhT.t('as', { name: '王芳' })).toBe('以王芳身份');
    expect(zhT.t('as', { name: 'Ada' })).toBe('以 Ada 身份');
    expect(zhT.t('as', { name: 'Ada 王' })).toBe('以 Ada 王身份');
    expect(zhT.t('as', { name: '王 Ada' })).toBe('以王 Ada 身份');
    expect(zhT.t('by', { name: '李明' })).toBe('由李明创建');
    expect(zhT.t('first', { name: '王芳', issue: 'BACK-1' })).toBe('王芳评论了 BACK-1');
    expect(zhT.t('count', { n: 3, name: '王芳' })).toBe('王芳有 3 个问题');
  });

  it('keeps the space beside a digit or a Latin letter, and the value’s own spaces', () => {
    expect(zhT.t('days', { name: '王芳' })).toBe('王芳 3 天');
    expect(zhT.t('as', { name: '王 芳' })).toBe('以王 芳身份');
    expect(zhT.t('two', { a: '王芳', b: 'Ada' })).toBe('王芳 Ada');
  });

  it('counts full-width punctuation and quotes as Chinese, and a value that is one of the catalog’s words', () => {
    expect(zhT.t('quoted', { name: '“王芳”' })).toBe('已添加“王芳”。');
    expect(zhT.t('quoted', { name: '“Ada”' })).toBe('已添加“Ada”。');
    expect(zhT.t('first', { name: '有人', issue: '此问题' })).toBe('有人评论了此问题');
    expect(squareAt('研发（北京）', true)).toBe(true);
    expect(squareAt('BACK', false)).toBe(false);
  });

  it('hears a value a tag holds, on either side of the tag', () => {
    expect(zhT.parts('tag', { v: '王芳', b })).toEqual([{ b: ['王芳'] }, '提交了请求']);
    expect(zhT.parts('tag', { v: 'Ada', b })).toEqual([{ b: ['Ada'] }, ' 提交了请求']);
    expect(zhT.parts('inside', { name: '王芳', b })).toEqual([{ b: ['以王芳身份'] }, ' 登录']);
  });

  it('spaces 和 and 或 from an item in Latin letters or digits, not from one in Chinese', () => {
    expect(joinList('zh', ['Anna Schmidt', 'Vera Viewer'])).toBe('Anna Schmidt 和 Vera Viewer');
    expect(joinList('zh', ['Anna Schmidt', 'Ben Okafor', '另外 3 人'])).toBe('Anna Schmidt、Ben Okafor 和另外 3 人');
    expect(joinList('zh', ['王芳', '李明'])).toBe('王芳和李明');
    expect(joinList('zh', ['王芳', 'Ada'])).toBe('王芳和 Ada');
    expect(joinList('zh', ['BACK', 'WEB', 'API'], { type: 'disjunction' })).toBe('BACK、WEB 或 API');
    expect(joinList('zh', ['BACK-12（State → Fixed）', 'BACK-13'])).toBe('BACK-12（State → Fixed）和 BACK-13');
    // Things one after another keep Intl's 「、」, unspaced.
    expect(joinItems('zh', ['Anna Schmidt', 'Vera Viewer'])).toBe('Anna Schmidt、Vera Viewer');
  });

  it('leaves Japanese, which spaces nothing, alone', () => {
    expect(createTranslator('ja', { as: '以 {name} 身份' }).t('as', { name: '王芳' })).toBe('以 王芳 身份');
  });
});

describe('Thai joins a value that is one of its catalog’s own words, and keeps a name’s spaces', () => {
  const thT = createTranslator('th', th);

  it('joins a catalog word on both sides, and spaces a Latin one', () => {
    expect(thT.t('common.copyButton.copied', { what: thT.t('agents.agentAccounts.theToken') })).toBe('คัดลอกโทเค็นแล้ว');
    expect(thT.t('common.copyButton.copied', { what: thT.t('helpdesk.portalSignIn.redirectUri') })).toBe('คัดลอก Redirect URI แล้ว');
    expect(thT.t('server.helpdesk.replied', { who: thT.t('server.helpdesk.theTeam') })).toBe('ทีมงานตอบกลับคำขอของคุณแล้ว');
    expect(thT.t('server.helpdesk.replied', { who: 'Anna Schmidt' })).toBe('Anna Schmidt ตอบกลับคำขอของคุณแล้ว');
  });

  it('keeps the space beside a name, which may be a pause before the next sentence', () => {
    expect(thT.t('plan.costs.noBudgetIsSetFor', { name: 'การตลาด' })).toMatch(/^ยังไม่ได้ตั้งงบประมาณให้ การตลาด ตั้งได้/);
    expect(thT.t('server.helpdesk.replied', { who: 'สมชาย' })).toBe('สมชาย ตอบกลับคำขอของคุณแล้ว');
  });
});

describe('a list among a message’s values, joined in its reader’s language', () => {
  const problem = (names: string[]): ProblemSaid => ({ key: 'issues.noSuchField', values: { project: 'BACK', name: 'Nope', names } });

  it('joins items as the language puts a list’s first items: English’s “, ”, Japanese’s and Chinese’s “、”', () => {
    expect(joinItems('en', ['Priority', 'State', 'Type'])).toBe('Priority, State, Type');
    expect(joinItems('ja', ['Priority', 'State', 'Type'])).toBe('Priority、State、Type');
    expect(joinItems('zh', ['Priority', 'State'])).toBe('Priority、State');
    expect(joinItems('th', ['Priority', 'State'])).toBe('Priority, State');
    expect(joinItems('en', ['Priority'])).toBe('Priority');
    expect(joinItems('en', [])).toBe('');
  });

  it('says a problem’s list in each language, English’s as the API joins it', () => {
    const said = (messages: Record<string, string>, locale: 'en' | 'ja' | 'zh') => sayProblem(createTranslator(locale, messages), problem(['Priority', 'State', 'Type']));
    expect(said(en, 'en')).toBe('Project BACK has no field "Nope". Fields: Priority, State, Type.');
    expect(said(ja, 'ja')).toContain('Priority、State、Type');
    expect(said(zh, 'zh')).toContain('Priority、State、Type');
    expect(said(ja, 'ja')).not.toContain(', ');
    expect(canSayProblem(createTranslator('ja', ja), problem(['A', 'B']))).toBe(true);
  });

  it('joins { and } and { or } with Intl’s word: Spanish’s “e” before an “i” sound', () => {
    const esT = createTranslator('es', es);
    const values = (pair: string[]) => ({ value: 'Alta', n: 2, fields: { and: pair }, first: pair[0]! });
    expect(sayProblem(esT, { key: 'command.valueOfFields', values: values(['Priority', 'Importancia']) })).toContain('es un valor de Priority e Importancia.');
    expect(sayProblem(esT, { key: 'command.valueOfFields', values: values(['Priority', 'Hielo']) })).toContain('Priority y Hielo');
    expect(sayProblem(esT, { key: 'command.valueOfFields', values: { ...values(['Priority', 'Impacto']), n: 3 } })).toContain('3 campos, entre ellos Priority e Impacto.');
    const enT = createTranslator('en', en);
    expect(sayProblem(enT, { key: 'command.valueOfFields', values: values(['Priority', 'Importance']) })).toBe('"Alta" is a value of Priority and Importance. Say which one, e.g. "Priority Alta".');
    expect(createTranslator('es', { x: '{v}' }).t('x', { v: { or: ['siete', 'ocho'] } })).toBe('siete u ocho');
  });

  it('tells a list from a problem and from a list of problems', () => {
    expect(isListSaid(['a', 'b'])).toBe(true);
    expect(isListSaid({ and: ['a'] })).toBe(true);
    expect(isListSaid({ key: 'x', values: {} })).toBe(false);
    expect(isListSaid([{ key: 'x' }])).toBe(false);
  });
});

describe('a browser asking for Traditional Chinese (D49)', () => {
  it('gets its next language, since a4a has Simplified alone, and the bare zh after a Traditional tag is its fallback', () => {
    expect(matchLocale('zh-TW,zh;q=0.9,en-US;q=0.8,en;q=0.7')).toBe('en');
    expect(matchLocale(['zh-Hant-HK', 'ja'])).toBe('ja');
    expect(matchLocale(['zh-MO'], 'de')).toBe('de');
  });
  it('still gets Simplified Chinese when it asks for it, wherever it is', () => {
    expect(matchLocale('zh-CN,zh;q=0.9,en;q=0.8')).toBe('zh');
    expect(matchLocale(['zh'])).toBe('zh');
    expect(matchLocale(['zh-Hans-TW'])).toBe('zh');
    expect(matchLocale(['zh-SG', 'en'])).toBe('zh');
  });
});

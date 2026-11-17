/**
 * What the visual editor stands on (docs/architecture.md, D39): pictures within text are a4a's own
 * raster images and nothing else; a checklist item is found by the grammar the page renders with;
 * and a comment, like an issue and an article, is edited against the version read.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { imageAttachment, imagePath, taskItems, toggleTask } from '@a4a/shared/markdown';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LocalDiskStorage, setAttachmentStorage } from '../src/attachments/storage';
import { createHttpApp } from '../src/http/app';
import { issueTokenFor } from '../src/services/auth';
import { addComment } from '../src/services/comments';
import { createIssue } from '../src/services/issues';
import { addMember, removeMember } from '../src/services/members';
import { updateProject } from '../src/services/projects';
import { createWorld, type TestWorld } from './helpers';

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(120, 7)]);
const SVG = '<?xml version="1.0"?>\n<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>';

let w: TestWorld;
let app: ReturnType<typeof createHttpApp>;
let root: string;
const tokens: Record<string, string> = {};
let issue: string;

async function call(method: string, url: string, opts: { as?: string; body?: unknown; form?: FormData; headers?: Record<string, string> } = {}) {
  const headers: Record<string, string> = { ...(opts.headers ?? {}), authorization: `Bearer ${tokens[opts.as ?? 'anna']}` };
  let body: RequestInit['body'];
  if (opts.form) body = opts.form;
  else if (opts.body !== undefined) {
    headers['content-type'] = 'application/json';
    body = JSON.stringify(opts.body);
  }
  const res = await app.request(`/api/v1${url}`, { method, headers, body });
  const type = res.headers.get('content-type') ?? '';
  const raw = Buffer.from(await res.arrayBuffer());
  return { status: res.status, headers: res.headers, raw, body: type.includes('application/json') && raw.length ? JSON.parse(raw.toString('utf8')) : null };
}

function upload(to: string, name: string, bytes: Buffer | string) {
  const form = new FormData();
  form.append('file', new Blob([typeof bytes === 'string' ? Buffer.from(bytes) : bytes]), name);
  return call('POST', to, { form });
}

beforeAll(async () => {
  w = await createWorld();
  root = mkdtempSync(path.join(tmpdir(), 'a4a-editor-'));
  setAttachmentStorage(w.app, new LocalDiskStorage(root));
  app = createHttpApp(w.app);
  tokens.anna = (await issueTokenFor(w.app.db, w.anna.id, { name: 'anna-ci', scopes: ['read', 'write'] })).token;
  tokens.ben = (await issueTokenFor(w.app.db, w.ben.id, { name: 'ben-ci', scopes: ['read', 'write'] })).token;
  issue = (await createIssue(w.as(w.anna), { project: 'BACK', summary: 'Screenshots in the description' })).id;
});

afterAll(async () => {
  await w.close();
  rmSync(root, { recursive: true, force: true });
});

describe('checklists, as the page reads them', () => {
  const text = [
    'Before the release:',
    '',
    '- [ ] Write the notes',
    '- [x] Tag the build',
    '  - [ ] Push the tag',
    '',
    '```',
    '- [ ] not an item: code',
    '```',
    '',
    '> 1. [X] quoted, and ticked',
    '',
    '[ ] not an item: no list',
    '',
    '* [ ] another bullet',
  ].join('\n');

  it('finds each item in order, and none in code or outside a list', () => {
    expect(taskItems(text).map((t) => [t.index, t.checked, text[t.at]])).toEqual([
      [0, false, ' '],
      [1, true, 'x'],
      [2, false, ' '],
      [3, true, 'X'],
      [4, false, ' '],
    ]);
  });

  it('ticks one item and changes nothing else, by its place', () => {
    const ticked = toggleTask(text, 2, true)!;
    expect(ticked).toBe(text.replace('  - [ ] Push the tag', '  - [x] Push the tag'));
    expect(taskItems(ticked)[2]!.checked).toBe(true);
    expect(toggleTask(text, 3, false)).toBe(text.replace('> 1. [X] quoted', '> 1. [ ] quoted'));
    expect(toggleTask(text, 5, true)).toBeNull();
  });
});

describe('pictures within text', () => {
  it('are a4a’s own image path, and nothing else', () => {
    expect(imagePath('a1b2')).toBe('/api/v1/attachments/a1b2/image');
    expect(imageAttachment('/api/v1/attachments/a1b2/image')).toBe('a1b2');
    for (const src of ['/api/v1/attachments/a1b2/content', 'https://evil.example/api/v1/attachments/a1b2/image', '//evil.example/api/v1/attachments/a1b2/image', '/api/v1/attachments/../x/image', '', null]) {
      expect(imageAttachment(src)).toBeNull();
    }
  });

  it('serves a raster image in place, and answers anything else as missing', async () => {
    const png = await upload(`/issues/${issue}/attachments`, 'screenshot.png', PNG);
    expect(png.status).toBe(201);
    const shown = await call('GET', `/attachments/${png.body.id}/image`);
    expect(shown.status).toBe(200);
    expect(shown.headers.get('content-type')).toBe('image/png');
    expect(shown.headers.get('content-disposition')).toMatch(/^inline/);
    expect(shown.headers.get('x-content-type-options')).toBe('nosniff');
    expect(shown.raw.equals(PNG)).toBe(true);
    expect((await call('GET', `/attachments/${png.body.id}/image`, { headers: { 'if-none-match': shown.headers.get('etag')! } })).status).toBe(304);

    // An SVG is a file of the issue, and downloads; within text it doesn't exist.
    const svg = await upload(`/issues/${issue}/attachments`, 'logo.svg', SVG);
    expect(svg.status).toBe(201);
    const refused = await call('GET', `/attachments/${svg.body.id}/image`);
    const missing = await call('GET', '/attachments/nothing-here/image');
    expect(refused.status).toBe(404);
    expect(refused.body).toEqual(missing.body);
    expect((await call('GET', `/attachments/${svg.body.id}/content`)).status).toBe(200);
  });

  it('shows a picture only to who can see its project, as missing to anyone else', async () => {
    const png = await upload(`/issues/${issue}/attachments`, 'secret.png', PNG);
    await updateProject(w.adminCtx, 'BACK', { visibility: 'members' });
    await addMember(w.adminCtx, 'BACK', { user: 'anna', role: 'member' });
    try {
      expect((await call('GET', `/attachments/${png.body.id}/image`)).status).toBe(200);
      const hidden = await call('GET', `/attachments/${png.body.id}/image`, { as: 'ben' });
      expect(hidden.status).toBe(404);
      expect(hidden.body).toEqual((await call('GET', '/attachments/nothing-here/image', { as: 'ben' })).body);
    } finally {
      await removeMember(w.adminCtx, 'BACK', 'anna');
      await updateProject(w.adminCtx, 'BACK', { visibility: 'open' });
    }
  });
});

describe('a comment, edited against the version read', () => {
  it('raises its version with each edit, and refuses one made against an older version', async () => {
    const comment = await addComment(w.as(w.anna), issue, '- [ ] Check the logs\n- [ ] Ask Ben');
    expect(comment.version).toBe(1);

    const ticked = await call('PATCH', `/comments/${comment.id}`, { body: { text: '- [x] Check the logs\n- [ ] Ask Ben', expectedVersion: 1 } });
    expect(ticked.status).toBe(200);
    expect(ticked.body).toMatchObject({ version: 2, text: '- [x] Check the logs\n- [ ] Ask Ben' });

    // A tick made on the page still showing version 1 is refused, and says which version is there.
    const stale = await call('PATCH', `/comments/${comment.id}`, { body: { text: '- [ ] Check the logs\n- [x] Ask Ben', expectedVersion: 1 } });
    expect(stale.status).toBe(409);
    expect(stale.body.error.details).toEqual({ version: 2 });
    expect((await call('GET', `/issues/${issue}/comments`)).body.find((c: { id: string }) => c.id === comment.id)).toMatchObject({ version: 2, text: '- [x] Check the logs\n- [ ] Ask Ben' });

    // Without a version, an edit is written as before.
    const plain = await call('PATCH', `/comments/${comment.id}`, { body: { text: 'Done.' } });
    expect(plain.body).toMatchObject({ version: 3, text: 'Done.' });
  });
});

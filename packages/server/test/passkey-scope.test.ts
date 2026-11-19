import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { groups, projects } from '../src/db/schema';
import type { AppError } from '../src/lib/errors';
import { addGroupMember, createGroup, updateGroup } from '../src/services/groups';
import { addMember } from '../src/services/members';
import { passkeyOwed, setPasskeyExempt } from '../src/services/passkey-policy';
import { updateProject } from '../src/services/projects';
import { insertUser } from '../src/services/users';
import { createWorld, type TestWorld } from './helpers';

let w: TestWorld;
let anna: Awaited<ReturnType<typeof insertUser>>;
let ben: Awaited<ReturnType<typeof insertUser>>;

const refusal = async (p: Promise<unknown>): Promise<AppError> => {
  try {
    await p;
  } catch (e) {
    return e as AppError;
  }
  throw new Error('expected a refusal');
};

beforeEach(async () => {
  w = await createWorld();
  anna = await insertUser(w.app.db, { login: 'scoped-anna', name: 'Scoped Anna', password: 'password-anna' });
  ben = await insertUser(w.app.db, { login: 'scoped-ben', name: 'Scoped Ben', password: 'password-ben' });
  w.app.schema.invalidate();
});

afterEach(async () => {
  await w.close();
});

describe('passkeys required by a group', () => {
  it('applies only to its people and honors the administrator exemption', async () => {
    const g = await createGroup(w.adminCtx, { name: 'Release team' });
    await addGroupMember(w.adminCtx, g.id, anna.login);
    expect(await passkeyOwed(w.app, anna)).toBe('no');
    expect(await passkeyOwed(w.app, ben)).toBe('no');

    const changed = await updateGroup(w.adminCtx, g.id, { requirePasskeys: true });
    expect(changed.requirePasskeys).toBe(true);
    expect(await passkeyOwed(w.app, anna)).toBe('owed');
    expect(await passkeyOwed(w.app, ben)).toBe('no');

    await setPasskeyExempt(w.adminCtx, anna.id, true);
    expect(await passkeyOwed(w.app, { ...anna, passkeyExemptAt: new Date() })).toBe('exempt');
    await updateGroup(w.adminCtx, g.id, { requirePasskeys: false });
    expect(await passkeyOwed(w.app, anna)).toBe('no');
  });

  it('refuses to leave every administrator unable to sign in and rolls the change back', async () => {
    const g = await createGroup(w.adminCtx, { name: 'Administrators on call' });
    await addGroupMember(w.adminCtx, g.id, w.admin.login);
    const e = await refusal(updateGroup(w.adminCtx, g.id, { requirePasskeys: true }));
    expect(e).toMatchObject({ status: 409, words: { key: 'passkeys.wouldLockOut' } });
    const [row] = await w.app.db.select().from(groups).where(eq(groups.id, g.id));
    expect(row?.requirePasskeys).toBe(false);
  });
});

describe('passkeys required by a project', () => {
  it('applies to its people, not to outsiders of a members-only project', async () => {
    await updateProject(w.adminCtx, 'BACK', { visibility: 'members' });
    await addMember(w.adminCtx, 'BACK', { user: anna.login, role: 'member' });
    await setPasskeyExempt(w.adminCtx, w.admin.id, true);
    const p = await updateProject(w.adminCtx, 'BACK', { settings: { requirePasskeys: true } });
    expect(p.settings.requirePasskeys).toBe(true);
    expect(await passkeyOwed(w.app, anna)).toBe('owed');
    expect(await passkeyOwed(w.app, ben)).toBe('no');
    expect(await passkeyOwed(w.app, { ...w.admin, passkeyExemptAt: new Date() })).toBe('exempt');
  });

  it('covers everyone who can access an open project', async () => {
    await setPasskeyExempt(w.adminCtx, w.admin.id, true);
    await updateProject(w.adminCtx, 'BACK', { settings: { requirePasskeys: true } });
    expect(await passkeyOwed(w.app, anna)).toBe('owed');
    expect(await passkeyOwed(w.app, ben)).toBe('owed');
  });

  it('uses the same last-administrator guard and rolls the project settings back', async () => {
    const e = await refusal(updateProject(w.adminCtx, 'BACK', { settings: { requirePasskeys: true } }));
    expect(e).toMatchObject({ status: 409, words: { key: 'passkeys.wouldLockOut' } });
    const [row] = await w.app.db.select().from(projects).where(eq(projects.key, 'BACK'));
    expect((row?.settings as { requirePasskeys?: boolean }).requirePasskeys ?? false).toBe(false);
  });
});

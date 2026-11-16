import type { Permission, RoleDef } from '@a4a/shared';
import { BUILTIN_ROLE_PERMISSIONS, PROJECT_ROLES } from '@a4a/shared/constants';
import { formatList, getLocale, inSentence, t } from '../../i18n';

/** What each permission lets someone do in a project (D37), as a short name and as a phrase. */
export const PERMISSION_NAMES: Record<Permission, string> = {
  read: t('roles.words.read'),
  comment: t('roles.words.comment'),
  create: t('roles.words.reportIssues'),
  edit: t('roles.words.changeIssues'),
  delete: t('roles.words.deleteIssues'),
  time: t('roles.words.logTime'),
  costs: t('roles.words.seeTimeAndCosts'),
  boards: t('roles.words.changeBoards'),
  manage: t('roles.words.manage'),
};

const PHRASES: Record<Permission, string> = {
  read: t('roles.words.readItsIssues'),
  comment: t('roles.words.commentOnThem'),
  create: t('roles.words.phraseReportIssues'),
  edit: t('roles.words.phraseChangeThem'),
  delete: t('roles.words.phraseDeleteThem'),
  time: t('roles.words.phraseLogTime'),
  costs: t('roles.words.seeTimeAndCosts2'),
  boards: t('roles.words.changeItsBoards'),
  manage: t('roles.words.changeItsSettingsAndPeople'),
};

export const PERMISSION_ABOUT: Record<Permission, string> = {
  read: t('roles.words.seeTheProjectAndIts'),
  comment: t('roles.words.commentOnIssues'),
  create: t('roles.words.reportNewIssues'),
  edit: t('roles.words.changeIssuesTheirFieldsWords'),
  delete: t('roles.words.deleteIssues2'),
  time: t('roles.words.logTimeOnIssues'),
  costs: t('roles.words.seeTheTimeLoggedAnd'),
  boards: t('roles.words.makeAndChangeBoardsAnd'),
  manage: t('roles.words.changeTheProjectSSettings'),
};

/** "read its issues, comment on them and see time and costs", to follow "may". */
export function permissionWords(perms: readonly Permission[]): string {
  const parts = perms.map((p) => PHRASES[p]);
  return parts.length ? formatList(parts) : t('roles.words.doNothing');
}

/** The built-in roles' names, in the page's language (D49). A role people made keeps the name they gave it. */
const BUILTIN_NAMES: Record<string, string> = {
  viewer: t('roles.builtin.viewer'),
  member: t('roles.builtin.member'),
  manager: t('roles.builtin.manager'),
  guest: t('roles.builtin.guest'),
};

/** A role's name as a page shows it: a built-in one in the page's language, one people made as they named it. */
export function roleLabel(id: string, name: string): string {
  return BUILTIN_NAMES[id] ?? name;
}

/** The built-in roles, for while the list from the server loads. */
export const BUILTIN_ROLES: RoleDef[] = PROJECT_ROLES.map((id) => ({
  id,
  name: roleLabel(id, id),
  description: '',
  permissions: [...BUILTIN_ROLE_PERMISSIONS[id]],
  builtin: true,
  uses: 0,
  version: 1,
})).sort((a, b) => ['manager', 'member', 'viewer'].indexOf(a.id) - ['manager', 'member', 'viewer'].indexOf(b.id));

/**
 * A role in a sentence (D49). English says it with its article, "a member", "an Auditor" ("A member"
 * where it starts the sentence); other languages say its name alone, as they say a role: "ist jetzt
 * Betrachter", "es ahora lector". A built-in role is in the page's language, lower-cased inside a
 * sentence where the language lower-cases its nouns; a role people made keeps its name.
 */
export function aRole(id: string, name: string, opts: { start?: boolean } = {}): string {
  const word = id in BUILTIN_NAMES ? inSentence(roleLabel(id, name)) : name;
  if (getLocale() !== 'en') return opts.start ? word.charAt(0).toUpperCase() + word.slice(1) : word;
  const article = /^[aeiou]/i.test(word) ? 'an' : 'a';
  return `${opts.start ? `A${article.slice(1)}` : article} ${word}`;
}

export function isBuiltinRole(id: string): boolean {
  return (PROJECT_ROLES as readonly string[]).includes(id);
}

/** Help for a role picker: "A member may read its issues, …". */
export function roleHelp(roles: readonly RoleDef[], id: string, who?: string): string {
  const r = roles.find((x) => x.id === id);
  if (!r) return '';
  const what = permissionWords(r.permissions);
  return who ? t('roles.words.isAtLeastRoleWhoMay', { who: who, role: aRole(r.id, r.name), what: what }) : t('roles.words.roleMay', { role: aRole(r.id, r.name, { start: true }), what: what });
}

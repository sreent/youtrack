import type { Permission, RoleDef } from '@a4a/shared';
import { BUILTIN_ROLE_NAMES, BUILTIN_ROLE_PERMISSIONS, PROJECT_ROLES } from '@a4a/shared/constants';

/** What each permission lets someone do in a project (D37), as a short name and as a phrase. */
export const PERMISSION_NAMES: Record<Permission, string> = {
  read: 'Read',
  comment: 'Comment',
  create: 'Report issues',
  edit: 'Change issues',
  delete: 'Delete issues',
  time: 'Log time',
  costs: 'See time and costs',
  boards: 'Change boards',
  manage: 'Manage',
};

const PHRASES: Record<Permission, string> = {
  read: 'read its issues',
  comment: 'comment on them',
  create: 'report issues',
  edit: 'change them',
  delete: 'delete them',
  time: 'log time',
  costs: 'see time and costs',
  boards: 'change its boards',
  manage: 'change its settings and people, and see every issue in it',
};

export const PERMISSION_ABOUT: Record<Permission, string> = {
  read: 'See the project and its issues. Every other permission needs it.',
  comment: 'Comment on issues.',
  create: 'Report new issues.',
  edit: 'Change issues: their fields, words, tags, links, and who sees them.',
  delete: 'Delete issues.',
  time: 'Log time on issues.',
  costs: 'See the time logged, and costs.',
  boards: 'Make and change boards and sprints.',
  manage: "Change the project's settings, people, rules, plan and help desk, and see every issue in it, whoever it's limited to.",
};

/** "read its issues, comment on them and see time and costs", to follow "may". */
export function permissionWords(perms: readonly Permission[]): string {
  const parts = perms.map((p) => PHRASES[p]);
  if (parts.length <= 1) return parts[0] ?? 'do nothing';
  return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
}

/** The built-in roles, for while the list from the server loads. */
export const BUILTIN_ROLES: RoleDef[] = PROJECT_ROLES.map((id) => ({
  id,
  name: BUILTIN_ROLE_NAMES[id],
  description: '',
  permissions: [...BUILTIN_ROLE_PERMISSIONS[id]],
  builtin: true,
  uses: 0,
  version: 1,
})).sort((a, b) => ['manager', 'member', 'viewer'].indexOf(a.id) - ['manager', 'member', 'viewer'].indexOf(b.id));

/** "a member" or "an Auditor": a role's name with its article, lower-cased when it's a built-in one. */
export function aRole(name: string, builtin = true): string {
  const word = builtin ? name.toLowerCase() : name;
  return `${/^[aeiou]/i.test(word) ? 'an' : 'a'} ${word}`;
}

export function isBuiltinRole(id: string): boolean {
  return (PROJECT_ROLES as readonly string[]).includes(id);
}

/** Help for a role picker: "A member may read its issues, …". */
export function roleHelp(roles: readonly RoleDef[], id: string, who?: string): string {
  const r = roles.find((x) => x.id === id);
  if (!r) return '';
  const what = permissionWords(r.permissions);
  return who ? `${who} is at least ${aRole(r.name, r.builtin)}, who may ${what}.` : `${aRole(r.name, r.builtin).replace(/^a/, 'A')} may ${what}.`;
}

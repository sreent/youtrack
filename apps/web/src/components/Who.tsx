import type { TrackerEvent, UserRef } from '@a4a/shared';
import { Icon } from './Icon';
import { t } from '../i18n';

export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '?';
  if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase();
  return `${parts[0]![0]}${parts[parts.length - 1]![0]}`.toUpperCase();
}

export type WhoKind = 'person' | 'agent' | 'service' | 'own';

/** People are round with initials; agents are lagoon squares with the agent's mark; services, the tool. */
export function Avatar({ kind, name, small }: { kind: WhoKind; name: string; small?: boolean }) {
  const sm = small ? ' small' : '';
  if (kind === 'agent')
    return (
      <span className={`avatar agent${sm}`} aria-hidden="true">
        <Icon name="agent" />
      </span>
    );
  if (kind === 'service')
    return (
      <span className={`avatar service${sm}`} aria-hidden="true">
        <Icon name="tool" />
      </span>
    );
  if (kind === 'own')
    return (
      <span className={`avatar own${sm}`} aria-hidden="true">
        <Icon name="audit" />
      </span>
    );
  return (
    <span className={`avatar${sm}`} aria-hidden="true">
      {initials(name)}
    </span>
  );
}

export function Who({ kind, name, about, small }: { kind: WhoKind; name: string; about?: string; small?: boolean }) {
  return (
    <span className="who" data-kind={kind}>
      <Avatar kind={kind} name={name} small={small} />
      <span>
        <span className="who-name">{name}</span>
        {about ? <span className="who-about"> {about}</span> : null}
      </span>
    </span>
  );
}

export function UserWho({ user, small, about }: { user: UserRef | null | undefined; small?: boolean; about?: string }) {
  if (!user) return <span className="faint">{t('ui.who.nobody')}</span>;
  return <Who kind={user.isBot ? 'agent' : 'person'} name={user.isBot ? user.login : user.name} small={small} about={about} />;
}

/**
 * Who acted, in Ocean's grammar: a person on the web; an agent (the assistant, an
 * MCP client) acting for a person; a service (a script with an API token).
 */
export function actorWho(actor: TrackerEvent['actor'], data?: TrackerEvent['data']): { kind: WhoKind; name: string; about: string } {
  const name = actor.name ?? actor.login ?? 'a4a';
  // An agent with a token of its own acts as itself, not for a person (D34).
  if (actor.isBot && (actor.channel === 'mcp' || actor.channel === 'api')) {
    return { kind: 'agent', name: actor.login ?? t('ui.who.anAgent'), about: actor.channel === 'mcp' ? t('ui.who.overMcpAsItself') : t('ui.who.throughTheApiAsItself') };
  }
  switch (actor.channel) {
    case 'helpdesk': {
      // Someone outside, through the help desk: a person, by the name they gave.
      const requester = (data?.requester as { name?: string } | undefined)?.name;
      return { kind: 'person', name: requester ?? t('ui.who.aRequester'), about: t('ui.who.throughTheHelpDesk') };
    }
    case 'assistant':
      return { kind: 'agent', name: 'assistant', about: t('ui.who.for', { name: name }) };
    case 'mcp':
      return { kind: 'agent', name: actor.token ?? t('ui.who.anAgent'), about: t('ui.who.overMcpFor', { name: name }) };
    case 'api':
      return { kind: 'service', name: actor.token ?? t('ui.who.aScript'), about: t('ui.who.throughTheApiAs', { name: name }) };
    case 'automation':
      return { kind: 'agent', name: actor.login ?? t('ui.who.automation'), about: t('ui.who.onItsOwn') };
    case 'vcs':
      // A commit's author a4a knows, through the integration; or the integration itself.
      return actor.id ? { kind: 'person', name, about: actor.token ? t('ui.who.from', { v: actor.token }) : t('ui.who.fromVersionControl') } : { kind: 'service', name: actor.token ?? t('ui.who.versionControl'), about: t('ui.who.fromVersionControl') };
    case 'chat':
      // A person, from Teams or Slack, as themselves (D42).
      return { kind: 'person', name, about: actor.token ? t('ui.who.from', { v: actor.token }) : t('ui.who.fromChat') };
    case 'ci':
      // A build CI reported, through its build source (D46).
      return { kind: 'service', name: actor.token ?? 'CI', about: t('ui.who.fromABuild') };
    case 'system':
      return { kind: 'own', name: 'a4a', about: '' };
    default:
      return { kind: 'person', name, about: '' };
  }
}

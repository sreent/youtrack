import type { TrackerEvent, UserRef } from '@a4a/shared';
import { Icon } from './Icon';

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
  if (!user) return <span className="faint">Nobody</span>;
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
    return { kind: 'agent', name: actor.login ?? 'an agent', about: actor.channel === 'mcp' ? 'over MCP, as itself' : 'through the API, as itself' };
  }
  switch (actor.channel) {
    case 'helpdesk': {
      // Someone outside, through the help desk: a person, by the name they gave.
      const requester = (data?.requester as { name?: string } | undefined)?.name;
      return { kind: 'person', name: requester ?? 'A requester', about: 'through the help desk' };
    }
    case 'assistant':
      return { kind: 'agent', name: 'assistant', about: `for ${name}` };
    case 'mcp':
      return { kind: 'agent', name: actor.token ?? 'an agent', about: `over MCP, for ${name}` };
    case 'api':
      return { kind: 'service', name: actor.token ?? 'a script', about: `through the API, as ${name}` };
    case 'automation':
      return { kind: 'agent', name: actor.login ?? 'automation', about: 'on its own' };
    case 'vcs':
      // A commit's author a4a knows, through the integration; or the integration itself.
      return actor.id ? { kind: 'person', name, about: `from ${actor.token ?? 'version control'}` } : { kind: 'service', name: actor.token ?? 'version control', about: 'from version control' };
    case 'chat':
      // A person, from Teams or Slack, as themselves (D42).
      return { kind: 'person', name, about: `from ${actor.token ?? 'chat'}` };
    case 'system':
      return { kind: 'own', name: 'a4a', about: '' };
    default:
      return { kind: 'person', name, about: '' };
  }
}

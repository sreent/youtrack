// By its own path, so the zod contract stays out of the browser's bundle.
import { MENTION, mentionLogin } from '@a4a/shared/mentions';
import { useMemo } from 'react';
import ReactMarkdown from 'react-markdown';
import { Link } from 'react-router';
import remarkGfm from 'remark-gfm';
import { useUsers } from '../api/queries';

const ISSUE_ID = /\b([A-Z][A-Z0-9]{1,9}-\d+)\b/g;

/** Turn bare issue ids into links (outside code), so agents and people can write "BACK-12". */
function linkIds(text: string): string {
  return text.replace(ISSUE_ID, (m) => `[${m}](/issues/${m})`);
}

function withLinkedIds(markdown: string): string {
  // Leave fenced and inline code alone.
  return markdown
    .split(/(```[\s\S]*?```|`[^`\n]*`)/)
    .map((part, i) => (i % 2 === 1 ? part : linkIds(part)))
    .join('');
}

/** A Markdown node, as far as mentions need one. */
interface MdNode {
  type: string;
  value?: string;
  url?: string;
  title?: string;
  children?: MdNode[];
  data?: Record<string, unknown>;
}

type Person = { login: string; name: string };

/** Where a person's name leads: what they're working on. */
export function personHref(login: string): string {
  return `/issues?q=${encodeURIComponent(`for: ${login} #Unresolved`)}`;
}

function splitMentions(text: string, find: (login: string) => Person | undefined): MdNode[] {
  const out: MdNode[] = [];
  let at = 0;
  for (const m of text.matchAll(MENTION)) {
    const start = m.index! + m[1]!.length;
    const login = mentionLogin(m[2]!, (l) => find(l)?.login ?? null);
    if (!login) continue;
    const person = find(login)!;
    if (start > at) out.push({ type: 'text', value: text.slice(at, start) });
    out.push({
      type: 'link',
      url: personHref(person.login),
      title: `@${person.login}`,
      data: { hProperties: { className: ['mention'] } },
      children: [{ type: 'text', value: person.name }],
    });
    at = start + 1 + login.length;
  }
  if (!out.length) return [{ type: 'text', value: text }];
  if (at < text.length) out.push({ type: 'text', value: text.slice(at) });
  return out;
}

/** "@anna" becomes Anna's name, a link to her; in code, links and other people's text it stays as written. */
function remarkMentions(find: (login: string) => Person | undefined) {
  return () => (tree: MdNode) => {
    const walk = (node: MdNode) => {
      if (!node.children || node.type === 'link' || node.type === 'linkReference') return;
      node.children = node.children.flatMap((child) => {
        if (child.type === 'text' && child.value?.includes('@')) return splitMentions(child.value, find);
        walk(child);
        return [child];
      });
    };
    walk(tree);
  };
}

/**
 * Markdown without raw HTML (react-markdown escapes it), with internal links routed, issue ids
 * linked and people's mentions shown by name. On a public page (`outside`), neither: what leads into
 * the tracker means nothing to someone who can't sign in.
 */
export function Markdown({ text, className, outside }: { text: string; className?: string; outside?: boolean }) {
  const users = useUsers({ enabled: !outside });
  const plugins = useMemo(() => {
    const byLogin = new Map<string, Person>();
    for (const u of users.data ?? []) byLogin.set(u.login.toLowerCase(), { login: u.login, name: u.isBot ? u.login : u.name });
    return outside || !byLogin.size ? [remarkGfm] : [remarkGfm, remarkMentions((l) => byLogin.get(l.toLowerCase()))];
  }, [users.data, outside]);
  return (
    <div className={className ? `prose ${className}` : 'prose'}>
      <ReactMarkdown
        remarkPlugins={plugins}
        components={{
          a: ({ href, children, className: cls, title }) =>
            href?.startsWith('/') && !outside ? (
              <Link to={href} title={title} className={cls === 'mention' ? 'mention' : /^\/issues\/[A-Z]/.test(href) ? 'issue-id' : undefined}>
                {children}
              </Link>
            ) : (
              <a href={href} target="_blank" rel="noreferrer noopener">
                {children}
              </a>
            ),
        }}
      >
        {outside ? text : withLinkedIds(text)}
      </ReactMarkdown>
    </div>
  );
}

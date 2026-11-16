// By their own paths, so the zod contract stays out of the browser's bundle (the page's CSP reports zod's eval check).
import { MENTION, mentionLogin } from '@a4a/shared/mentions';
import { findRefs } from '@a4a/shared/refs';
import { useMemo } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import { Link } from 'react-router';
import remarkGfm from 'remark-gfm';
import { useUsers } from '../api/queries';

/**
 * Turn bare issue ids (BACK-12) and article ids (BACK-A-3) into links, outside code, so agents
 * and people can write either. The reading is the server's own (@a4a/shared findRefs), so what
 * links here is what counts as a mention there.
 */
function withLinkedIds(markdown: string): string {
  let out = '';
  let at = 0;
  for (const ref of findRefs(markdown)) {
    out += markdown.slice(at, ref.start) + `[${ref.id}](/${ref.kind === 'article' ? 'articles' : 'issues'}/${ref.id})`;
    at = ref.end;
  }
  return out + markdown.slice(at);
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

const ID_LINK = /^\/(issues|articles)\/[A-Z]/;
const HEADINGS = ['h1', 'h2', 'h3', 'h4', 'h5', 'h6'] as const;

/**
 * Markdown without raw HTML (react-markdown escapes it), with internal links routed, issue and article
 * ids linked and people's mentions shown by name. On a public page (`outside`), neither: what leads
 * into the tracker means nothing to someone who can't sign in. `headingsFrom` starts its headings
 * lower, so a page keeps its own first-level heading: an article's "# Setup" is an h2.
 */
export function Markdown({ text, className, outside, headingsFrom = 1 }: { text: string; className?: string; outside?: boolean; headingsFrom?: 1 | 2 }) {
  const users = useUsers({ enabled: !outside });
  const plugins = useMemo(() => {
    const byLogin = new Map<string, Person>();
    for (const u of users.data ?? []) byLogin.set(u.login.toLowerCase(), { login: u.login, name: u.isBot ? u.login : u.name });
    return outside || !byLogin.size ? [remarkGfm] : [remarkGfm, remarkMentions((l) => byLogin.get(l.toLowerCase()))];
  }, [users.data, outside]);
  const components: Components = {
    a: ({ href, children, className: cls, title }) =>
      href?.startsWith('/') && !outside ? (
        <Link to={href} title={title} className={cls === 'mention' ? 'mention' : ID_LINK.test(href) ? 'issue-id' : undefined}>
          {children}
        </Link>
      ) : (
        <a href={href} target="_blank" rel="noreferrer noopener">
          {children}
        </a>
      ),
  };
  if (headingsFrom > 1) {
    HEADINGS.forEach((tag, i) => {
      const As = HEADINGS[Math.min(i + headingsFrom - 1, 5)]!;
      components[tag] = ({ children }) => <As>{children}</As>;
    });
  }
  return (
    <div className={className ? `prose ${className}` : 'prose'}>
      <ReactMarkdown remarkPlugins={plugins} components={components}>
        {outside ? text : withLinkedIds(text)}
      </ReactMarkdown>
    </div>
  );
}

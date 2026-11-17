// By their own paths, so the zod contract stays out of the browser's bundle (the page's CSP reports zod's eval check).
import { imageAttachment } from '@a4a/shared/markdown';
import { MENTION, mentionLogin } from '@a4a/shared/mentions';
import { findRefs } from '@a4a/shared/refs';
import { useMemo } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import { Link } from 'react-router';
import remarkGfm from 'remark-gfm';
import { useUsers } from '../api/queries';
import { t } from '../i18n';

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

/** An HTML node, as far as checklists need one. */
interface HNode {
  type: string;
  tagName?: string;
  value?: string;
  properties?: Record<string, unknown>;
  children?: HNode[];
}

const textOf = (node: HNode): string =>
  node.type === 'text' ? (node.value ?? '') : node.tagName === 'ul' || node.tagName === 'ol' ? '' : (node.children ?? []).map(textOf).join('');

/**
 * Number each checklist box in the order it's read, and give it its item's words to be known by.
 * The numbers are those of @a4a/shared/markdown's taskItems, read with the same grammar, so a box
 * ticked here is the item ticked in the text (D39).
 */
function rehypeTasks() {
  return (tree: HNode) => {
    let n = 0;
    const walk = (node: HNode) => {
      if (node.tagName === 'li') {
        const box = node.children?.find((c) => c.tagName === 'input' && c.properties?.type === 'checkbox');
        if (box) {
          box.properties = { ...box.properties, dataTask: String(n++), ariaLabel: textOf(node).trim().slice(0, 120) || t('ui.markdown.aChecklistItem') };
        }
      }
      node.children?.forEach(walk);
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
 *
 * A picture shows only when it's one of a4a's own raster images (`/attachments/{id}/image`, D39);
 * any other, from elsewhere or of another kind, is named, never fetched. With `onToggleTask`,
 * checklist boxes can be ticked: it's told which item, by its place, and whether it's now done.
 */
export function Markdown({
  text,
  className,
  outside,
  headingsFrom = 1,
  onToggleTask,
}: {
  text: string;
  className?: string;
  outside?: boolean;
  headingsFrom?: 1 | 2;
  onToggleTask?: (index: number, checked: boolean) => void;
}) {
  const users = useUsers({ enabled: !outside });
  const plugins = useMemo(() => {
    const byLogin = new Map<string, Person>();
    for (const u of users.data ?? []) byLogin.set(u.login.toLowerCase(), { login: u.login, name: u.isBot ? u.login : u.name });
    return outside || !byLogin.size ? [remarkGfm] : [remarkGfm, remarkMentions((l) => byLogin.get(l.toLowerCase()))];
  }, [users.data, outside]);
  const components: Components = {
    a: ({ href, children, className: cls, title }) =>
      href?.startsWith('/api/') ? (
        // A file of a4a's: fetched by the browser, not routed by the app.
        <a href={href}>{children}</a>
      ) : href?.startsWith('/') && !outside ? (
        <Link to={href} title={title} className={cls === 'mention' ? 'mention' : ID_LINK.test(href) ? 'issue-id' : undefined}>
          {children}
        </Link>
      ) : (
        <a href={href} target="_blank" rel="noreferrer noopener">
          {children}
        </a>
      ),
    img: ({ src, alt }) => {
      const source = typeof src === 'string' ? src : '';
      if (!outside && imageAttachment(source)) return <img src={source} alt={alt ?? ''} loading="lazy" decoding="async" />;
      // Never fetched: from elsewhere, or a4a's own where nobody is signed in to see it.
      const name = alt?.trim() || t('ui.markdown.aPicture');
      return /^https?:\/\//i.test(source) && !outside ? (
        <a className="image-elsewhere" href={source} target="_blank" rel="noreferrer noopener">
          {name}
        </a>
      ) : (
        <span className="image-elsewhere">{name}</span>
      );
    },
    input: ({ type, checked, ...props }) => {
      // Markdown makes no other input (raw HTML is escaped): a checklist's box, or nothing.
      if (type !== 'checkbox') return null;
      const index = Number((props as Record<string, unknown>)['data-task']);
      const label = (props as Record<string, unknown>)['aria-label'] as string | undefined;
      return onToggleTask && Number.isInteger(index) ? (
        <input type="checkbox" checked={Boolean(checked)} aria-label={label} onChange={(e) => onToggleTask(index, e.target.checked)} />
      ) : (
        <input type="checkbox" checked={Boolean(checked)} aria-label={label} disabled readOnly />
      );
    },
  };
  if (headingsFrom > 1) {
    HEADINGS.forEach((tag, i) => {
      const As = HEADINGS[Math.min(i + headingsFrom - 1, 5)]!;
      components[tag] = ({ children }) => <As>{children}</As>;
    });
  }
  return (
    <div className={className ? `prose ${className}` : 'prose'}>
      <ReactMarkdown remarkPlugins={plugins} rehypePlugins={[rehypeTasks]} components={components}>
        {outside ? text : withLinkedIds(text)}
      </ReactMarkdown>
    </div>
  );
}

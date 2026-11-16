// From refs alone: the package's root would bring zod, whose eval check the page's CSP reports.
import { findRefs } from '@a4a/shared/refs';
import ReactMarkdown, { type Components } from 'react-markdown';
import { Link } from 'react-router';
import remarkGfm from 'remark-gfm';

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

const ID_LINK = /^\/(issues|articles)\/[A-Z]/;
const HEADINGS = ['h1', 'h2', 'h3', 'h4', 'h5', 'h6'] as const;

/**
 * Markdown without raw HTML (react-markdown escapes it), with internal links routed. `headingsFrom`
 * starts its headings lower, so a page keeps its own first-level heading: an article's "# Setup" is an h2.
 */
export function Markdown({ text, className, headingsFrom = 1 }: { text: string; className?: string; headingsFrom?: 1 | 2 }) {
  const components: Components = {
    a: ({ href, children }) =>
      href?.startsWith('/') ? (
        <Link to={href} className={ID_LINK.test(href) ? 'issue-id' : undefined}>
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
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {withLinkedIds(text)}
      </ReactMarkdown>
    </div>
  );
}

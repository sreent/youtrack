import ReactMarkdown from 'react-markdown';
import { Link } from 'react-router';
import remarkGfm from 'remark-gfm';

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

/** Markdown without raw HTML (react-markdown escapes it), with internal links routed. */
export function Markdown({ text, className }: { text: string; className?: string }) {
  return (
    <div className={className ? `prose ${className}` : 'prose'}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ href, children }) =>
            href?.startsWith('/') ? (
              <Link to={href} className={/^\/issues\/[A-Z]/.test(href) ? 'issue-id' : undefined}>
                {children}
              </Link>
            ) : (
              <a href={href} target="_blank" rel="noreferrer noopener">
                {children}
              </a>
            ),
        }}
      >
        {withLinkedIds(text)}
      </ReactMarkdown>
    </div>
  );
}

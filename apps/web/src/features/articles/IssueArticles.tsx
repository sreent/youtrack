import { Link } from 'react-router';
import { useIssueArticles } from './api';

/** The knowledge base's articles that mention an issue by its id; nothing at all when none do. */
export function IssueArticles({ issueId }: { issueId: string }) {
  const articles = useIssueArticles(issueId);
  if (!articles.data?.length) return null;
  return (
    <section className="card issue-links-box stack" aria-labelledby="issue-articles-title">
      <h2 id="issue-articles-title">In the knowledge base</h2>
      <ul className="link-list">
        {articles.data.map((a) => (
          <li key={a.id}>
            <span className="issue-id">{a.id}</span>
            <Link to={`/articles/${a.id}`}>{a.title}</Link>
          </li>
        ))}
      </ul>
    </section>
  );
}

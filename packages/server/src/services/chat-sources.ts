/**
 * Where an issue made from a Teams or Slack message came from (D60), as its readers see it. Read with
 * the issue itself (issueDetail), so it shows exactly where the issue does and nowhere else: REST, MCP,
 * the assistant and the page all have it through the access seam that found the issue.
 */
import type { ChatIssueSource, ChatPlatform } from '@a4a/shared';
import { eq } from 'drizzle-orm';
import type { Db } from '../db/client';
import { chatIssueSources } from '../db/schema';

type SourceRow = typeof chatIssueSources.$inferSelect;

export function chatSourceDto(row: SourceRow): ChatIssueSource {
  return {
    platform: row.platform as ChatPlatform,
    workspace: row.workspaceName,
    channel: row.channelName,
    url: row.url,
    author: row.authorName,
    sentAt: row.sentAt?.toISOString() ?? null,
    replies: row.replies,
    files: row.files,
    moreFiles: row.moreFiles,
    cut: row.cut,
  };
}

/** The source of an issue the caller already sees, or null for one made any other way. */
export async function chatSourceOf(db: Db, issueId: string): Promise<ChatIssueSource | null> {
  const [row] = await db.select().from(chatIssueSources).where(eq(chatIssueSources.issueId, issueId));
  return row ? chatSourceDto(row) : null;
}

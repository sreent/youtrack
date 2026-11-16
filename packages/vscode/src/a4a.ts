/**
 * a4a, as the extension talks to it: its MCP server's tools, over Streamable HTTP at /mcp. An app's
 * OAuth token is for /mcp alone (D28), and an API token works there too, so one way serves both.
 * Each call is one JSON-RPC request; a4a's MCP endpoint is stateless.
 */

export interface IssueRow {
  id: string;
  summary: string;
  state: string | null;
  priority: string | null;
  type: string | null;
  assignee: string | null;
  tags?: string[];
  updated: string;
}

export interface IssueFull {
  id: string;
  url: string;
  summary: string;
  project: string;
  fields: Record<string, unknown>;
  tags: string[];
  reporter: string | null;
  created: string;
  updated: string;
  resolved: string | null;
  description: string;
  comments?: { by: string | null; at?: string; text: string }[];
}

/** Something a4a said no to, in its words: what's wrong and what to do. */
export class A4aError extends Error {
  constructor(
    message: string,
    readonly kind: 'auth' | 'refused' | 'unreachable',
  ) {
    super(message);
  }
}

export type Fetch = typeof fetch;

export class A4a {
  private id = 0;

  constructor(
    /** The a4a's own address, without a trailing slash. */
    readonly base: string,
    private readonly token: () => Promise<string | null>,
    private readonly fetchImpl: Fetch = fetch,
  ) {}

  /** Call one of a4a's tools: its data, or its refusal as an A4aError. */
  async tool<T>(name: string, args: Record<string, unknown>): Promise<T> {
    const token = await this.token();
    if (!token) throw new A4aError('Sign in to a4a first.', 'auth');
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.base}/mcp`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
        body: JSON.stringify({ jsonrpc: '2.0', id: ++this.id, method: 'tools/call', params: { name, arguments: args } }),
      });
    } catch {
      throw new A4aError(`a4a at ${this.base} doesn't answer.`, 'unreachable');
    }
    if (res.status === 401) throw new A4aError('a4a didn’t take the token: sign in again.', 'auth');
    if (res.status === 403) {
      const body = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
      throw new A4aError(body?.error?.message ?? 'a4a says you may not do that.', 'refused');
    }
    if (!res.ok) throw new A4aError(`a4a answered ${res.status}.`, 'unreachable');
    const msg = (await res.json()) as { result?: { isError?: boolean; content?: { type: string; text?: string }[] }; error?: { message?: string } };
    if (msg.error) throw new A4aError(msg.error.message ?? 'a4a refused the call.', 'refused');
    const text = msg.result?.content?.find((c) => c.type === 'text')?.text ?? '';
    if (msg.result?.isError) throw new A4aError(text || 'a4a refused it.', 'refused');
    return JSON.parse(text) as T;
  }

  async search(query: string, limit = 50): Promise<{ total: number; issues: IssueRow[] }> {
    return this.tool('search_issues', { query, limit });
  }

  async issue(id: string): Promise<IssueFull> {
    return this.tool('get_issue', { issue: id, comments: 10 });
  }

  async apply(id: string, command: string): Promise<unknown> {
    return this.tool('apply_command', { issues: [id], command });
  }

  async create(project: string, summary: string, description: string): Promise<{ id: string; url?: string }> {
    return this.tool('create_issue', { project, summary, description });
  }

  async me(): Promise<{ login: string; name: string }> {
    return this.tool('get_current_user', {});
  }
}

/** An issue id as a commit names it (D26): a project key, a dash, a number. */
export const ISSUE_ID = /^[A-Za-z][A-Za-z0-9]{1,9}-\d{1,9}$/;

/** The commit message with an issue named at its start, once. */
export function nameIssue(message: string, id: string): string {
  const trimmed = message.trimStart();
  if (new RegExp(`(^|\\W)${id}(\\W|$)`, 'i').test(trimmed)) return message;
  return trimmed ? `${id} ${trimmed}` : `${id} `;
}

/** A new issue's words from selected code: where it is, and the code itself, fenced. */
export function fromSelection(input: { path: string; startLine: number; endLine: number; code: string; language: string; permalink?: string | null }): { summary: string; description: string } {
  const lines = input.startLine === input.endLine ? `line ${input.startLine}` : `lines ${input.startLine}–${input.endLine}`;
  const where = input.permalink ? `[${input.path}, ${lines}](${input.permalink})` : `\`${input.path}\`, ${lines}`;
  const fence = input.code.includes('```') ? '````' : '```';
  const first = input.code.split('\n').find((l) => l.trim())?.trim() ?? input.path;
  return {
    summary: `In ${input.path.split('/').pop()}: ${first.slice(0, 80)}`,
    description: `${where}:\n\n${fence}${input.language}\n${input.code}\n${fence}\n`,
  };
}

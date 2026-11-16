/**
 * The specs' own way to the REST API, with the run's token: to arrange what a test needs, to
 * change something behind a page's back (as another person or a script would), and to check
 * what a page saved. The types are the contract's, so a change to it shows here first.
 */
import { readFileSync } from 'node:fs';
import { expect, request, type APIRequestContext, type APIResponse } from '@playwright/test';
import type { Board, CreateIssueInput, IssueDetail, IssueList, Project, User, Webhook } from '@a4a/shared';
import { BASE_URL, TOKEN_FILE } from './env';

export class Api {
  private constructor(readonly context: APIRequestContext) {}

  static async open(): Promise<Api> {
    const { token } = JSON.parse(readFileSync(TOKEN_FILE, 'utf8')) as { token: string };
    return new Api(await request.newContext({ baseURL: BASE_URL, extraHTTPHeaders: { authorization: `Bearer ${token}` } }));
  }

  async dispose(): Promise<void> {
    await this.context.dispose();
  }

  private async json<T>(res: APIResponse, what: string): Promise<T> {
    expect(res.ok(), `${what}: ${res.status()} ${await res.text()}`).toBe(true);
    return res.status() === 204 ? (undefined as T) : ((await res.json()) as T);
  }

  get<T>(path: string): Promise<T> {
    return this.context.get(`/api/v1${path}`).then((r) => this.json<T>(r, `GET ${path}`));
  }

  post<T>(path: string, data: unknown = {}): Promise<T> {
    return this.context.post(`/api/v1${path}`, { data }).then((r) => this.json<T>(r, `POST ${path}`));
  }

  patch<T>(path: string, data: unknown): Promise<T> {
    return this.context.patch(`/api/v1${path}`, { data }).then((r) => this.json<T>(r, `PATCH ${path}`));
  }

  delete(path: string): Promise<void> {
    return this.context.delete(`/api/v1${path}`).then((r) => this.json<void>(r, `DELETE ${path}`));
  }

  // --- What specs arrange and read -----------------------------------------------------

  /** A project of the spec's own, so specs running at once never see each other's issues. */
  createProject(input: { key: string; name: string; template?: 'software' | 'waterfall' | 'blank'; lead?: string }): Promise<Project> {
    return this.post<Project>('/projects', input);
  }

  createIssue(input: CreateIssueInput): Promise<IssueDetail> {
    return this.post<IssueDetail>('/issues', input);
  }

  issue(id: string): Promise<IssueDetail> {
    return this.get<IssueDetail>(`/issues/${id}`);
  }

  updateIssue(id: string, body: { summary?: string; fields?: Record<string, string | string[] | null>; expectedVersion?: number }): Promise<IssueDetail> {
    return this.patch<IssueDetail>(`/issues/${id}`, body);
  }

  search(query: string): Promise<IssueList> {
    return this.get<IssueList>(`/issues?query=${encodeURIComponent(query)}&limit=200`);
  }

  createBoard(input: { name: string; projects: string[]; columns?: { name: string; values: string[]; wipLimit?: number | null }[]; sprintsEnabled?: boolean }): Promise<Board> {
    return this.post<Board>('/boards', input);
  }

  boards(): Promise<Board[]> {
    return this.get<Board[]>('/boards');
  }

  createUser(input: { login: string; name: string; password: string; role?: 'admin' | 'member' | 'viewer' }): Promise<User> {
    return this.post<User>('/users', input);
  }

  users(): Promise<User[]> {
    return this.get<User[]>('/users');
  }

  webhooks(): Promise<Webhook[]> {
    return this.get<Webhook[]>('/webhooks');
  }
}

/** A field's value as people read it: a name, a login, a period's words, a date. */
export function fieldValue(issue: IssueDetail, name: string): string | null {
  const v = issue.fields.find((f) => f.name === name)?.value;
  if (v === null || v === undefined) return null;
  if (Array.isArray(v)) return v.map((x) => ('login' in x ? x.login : x.name)).join(', ');
  if (typeof v === 'object') {
    if ('login' in v) return v.login;
    if ('presentation' in v) return v.presentation;
    if ('name' in v) return v.name;
  }
  return String(v);
}

/** A project key no other spec, run or retry has: two letters of the spec's own, then five more. */
export function uniqueKey(prefix: string): string {
  const tail = Math.random().toString(36).slice(2, 7).toUpperCase().padEnd(5, 'X');
  return `${prefix}${tail}`.slice(0, 10);
}

/** A short random word, for names that must not collide across runs and retries. */
export function unique(): string {
  return Math.random().toString(36).slice(2, 8);
}

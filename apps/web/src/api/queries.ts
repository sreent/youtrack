/** React Query hooks for the a4a API. Keys are hierarchical so live events can invalidate broadly. */
import type {
  AIStatus,
  ApiToken,
  Board,
  BoardView,
  Comment,
  Conversation,
  ConversationDetail,
  Field,
  IssueDetail,
  IssueLink,
  IssueList,
  LinkType,
  Me,
  OAuthGrant,
  Project,
  ProjectField,
  ProjectMember,
  SavedSearch,
  Settings,
  SetupStatus,
  Suggestion,
  Tag,
  TrackerEvent,
  User,
  Webhook,
  WorkItem,
} from '@a4a/shared';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { get, qs } from './client';

export const keys = {
  me: ['me'] as const,
  setup: ['setup'] as const,
  projects: ['projects'] as const,
  project: (key: string) => ['projects', key] as const,
  projectFields: (key: string) => ['projects', key, 'fields'] as const,
  members: (key: string) => ['projects', key, 'members'] as const,
  issues: (query: string, offset: number, limit: number) => ['issues', 'list', query, offset, limit] as const,
  issue: (id: string) => ['issues', 'one', id] as const,
  issueSub: (id: string, what: string) => ['issues', 'one', id, what] as const,
  users: ['users'] as const,
  tags: ['tags'] as const,
  fields: ['fields'] as const,
  linkTypes: ['link-types'] as const,
  savedSearches: ['saved-searches'] as const,
  boards: ['boards'] as const,
  boardView: (id: string, sprint?: string) => ['boards', id, 'view', sprint ?? ''] as const,
  aiStatus: ['ai', 'status'] as const,
  conversations: ['ai', 'conversations'] as const,
  conversation: (id: string) => ['ai', 'conversations', id] as const,
  tokens: ['me', 'tokens'] as const,
  oauthGrants: ['me', 'oauth-grants'] as const,
  webhooks: ['webhooks'] as const,
  settings: ['settings'] as const,
  events: (q: string) => ['events', q] as const,
};

export const useSetupStatus = () => useQuery({ queryKey: keys.setup, queryFn: () => get<SetupStatus>('/auth/setup') });
export const useMe = () => useQuery({ queryKey: keys.me, queryFn: () => get<Me>('/me'), retry: false, staleTime: 60_000 });
export const useProjects = () => useQuery({ queryKey: keys.projects, queryFn: () => get<Project[]>('/projects'), staleTime: 30_000 });
export const useProject = (key: string | undefined) =>
  useQuery({ queryKey: keys.project(key ?? ''), queryFn: () => get<Project>(`/projects/${key}`), enabled: Boolean(key) });
export const useMembers = (key: string | undefined) =>
  useQuery({ queryKey: keys.members(key ?? ''), queryFn: () => get<ProjectMember[]>(`/projects/${key}/members`), enabled: Boolean(key), staleTime: 30_000 });
export const useProjectFields = (key: string | undefined) =>
  useQuery({ queryKey: keys.projectFields(key ?? ''), queryFn: () => get<ProjectField[]>(`/projects/${key}/fields`), enabled: Boolean(key), staleTime: 30_000 });

export const useIssues = (query: string, offset = 0, limit = 50) =>
  useQuery({
    queryKey: keys.issues(query, offset, limit),
    queryFn: () => get<IssueList>(`/issues${qs({ query, offset, limit })}`),
    placeholderData: keepPreviousData,
    retry: false,
  });
export const useIssue = (id: string | undefined) =>
  useQuery({ queryKey: keys.issue(id ?? ''), queryFn: () => get<IssueDetail>(`/issues/${id}`), enabled: Boolean(id), retry: false });
export const useComments = (id: string) => useQuery({ queryKey: keys.issueSub(id, 'comments'), queryFn: () => get<Comment[]>(`/issues/${id}/comments`) });
export const useActivity = (id: string) => useQuery({ queryKey: keys.issueSub(id, 'activity'), queryFn: () => get<TrackerEvent[]>(`/issues/${id}/activity`) });
export const useLinks = (id: string) => useQuery({ queryKey: keys.issueSub(id, 'links'), queryFn: () => get<IssueLink[]>(`/issues/${id}/links`) });
export const useWorkItems = (id: string) => useQuery({ queryKey: keys.issueSub(id, 'work'), queryFn: () => get<WorkItem[]>(`/issues/${id}/work-items`) });
export const useSuggestions = (id: string, enabled = true) =>
  useQuery({ queryKey: keys.issueSub(id, 'suggestions'), queryFn: () => get<Suggestion[]>(`/issues/${id}/suggestions`), enabled });

export const useUsers = (opts: { enabled?: boolean } = {}) =>
  useQuery({ queryKey: keys.users, queryFn: () => get<User[]>('/users'), staleTime: 60_000, enabled: opts.enabled ?? true });
export const useTags = () => useQuery({ queryKey: keys.tags, queryFn: () => get<Tag[]>('/tags'), staleTime: 60_000 });
export const useFields = () => useQuery({ queryKey: keys.fields, queryFn: () => get<Field[]>('/fields') });
export const useLinkTypes = () => useQuery({ queryKey: keys.linkTypes, queryFn: () => get<LinkType[]>('/link-types'), staleTime: 300_000 });
export const useSavedSearches = () => useQuery({ queryKey: keys.savedSearches, queryFn: () => get<SavedSearch[]>('/saved-searches') });
export const useBoards = () => useQuery({ queryKey: keys.boards, queryFn: () => get<Board[]>('/boards') });
export const useBoardView = (id: string | undefined, sprint?: string) =>
  useQuery({ queryKey: keys.boardView(id ?? '', sprint), queryFn: () => get<BoardView>(`/boards/${id}/view${qs({ sprint })}`), enabled: Boolean(id) });
export const useAIStatus = () => useQuery({ queryKey: keys.aiStatus, queryFn: () => get<AIStatus>('/ai/status'), staleTime: 300_000 });
export const useConversations = () => useQuery({ queryKey: keys.conversations, queryFn: () => get<Conversation[]>('/ai/conversations') });
export const useConversation = (id: string | undefined) =>
  useQuery({ queryKey: keys.conversation(id ?? ''), queryFn: () => get<ConversationDetail>(`/ai/conversations/${id}`), enabled: Boolean(id) });
export const useTokens = () => useQuery({ queryKey: keys.tokens, queryFn: () => get<ApiToken[]>('/me/tokens') });
export const useOAuthGrants = () => useQuery({ queryKey: keys.oauthGrants, queryFn: () => get<OAuthGrant[]>('/me/oauth-grants') });
/** Administrators only: `enabled` false asks nothing of the server. */
export const useWebhooks = (enabled = true) => useQuery({ queryKey: keys.webhooks, queryFn: () => get<Webhook[]>('/webhooks'), enabled });
export const useSettings = () => useQuery({ queryKey: keys.settings, queryFn: () => get<Settings>('/settings') });
export const useEvents = (params: { project?: string; since?: string; limit?: number }) =>
  useQuery({ queryKey: keys.events(JSON.stringify(params)), queryFn: () => get<TrackerEvent[]>(`/events${qs(params)}`) });

/**
 * Whiteboards' reads and writes (D58). A whiteboard's elements live on its page, kept by its live
 * stream; its cards are a query of their own, under 'whiteboard-cards', which the shell's live events
 * read again whenever an issue or an article changes, so a card follows its issue.
 */
import type { Whiteboard, WhiteboardBatchInput, WhiteboardBatchResult, WhiteboardCard, WhiteboardConvertInput, WhiteboardConvertResult, WhiteboardDetail } from '@a4a/shared';
import { useQuery } from '@tanstack/react-query';
import { del, get, patch, post, qs } from '../../api/client';

export const whiteboardKeys = {
  all: ['whiteboards'] as const,
  list: (project: string) => ['whiteboards', 'list', project] as const,
  detail: (id: string) => ['whiteboards', 'detail', id] as const,
  cards: (id: string) => ['whiteboard-cards', id] as const,
};

export const useWhiteboards = (project = '') =>
  useQuery({ queryKey: whiteboardKeys.list(project), queryFn: () => get<Whiteboard[]>(`/whiteboards${qs({ project: project || undefined })}`) });

/** Read once; from then on its live stream keeps the page's copy. */
export const useWhiteboard = (id: string | undefined) =>
  useQuery({ queryKey: whiteboardKeys.detail(id ?? ''), queryFn: () => get<WhiteboardDetail>(`/whiteboards/${id}`), enabled: Boolean(id), staleTime: Infinity, refetchOnWindowFocus: false });

export const useWhiteboardCards = (id: string | undefined, initial: WhiteboardCard[] | undefined, live = true) =>
  useQuery({ queryKey: whiteboardKeys.cards(id ?? ''), queryFn: () => get<WhiteboardCard[]>(`/whiteboards/${id}/cards`), enabled: Boolean(id && initial && live), initialData: initial });

export const createWhiteboard = (body: { project?: string; name: string; share?: 'everyone' | 'limited'; sharedWith?: { users: string[]; groups: string[] } }) => post<Whiteboard>('/whiteboards', body);
export const setWhiteboardSharing = (id: string, body: { share: 'everyone' | 'limited'; sharedWith?: { users: string[]; groups: string[] } }) => patch<Whiteboard>(`/whiteboards/${id}/sharing`, body);
export const renameWhiteboard = (id: string, name: string) => patch<Whiteboard>(`/whiteboards/${id}`, { name });
export const deleteWhiteboard = (id: string) => del(`/whiteboards/${id}`);
export const sendBatch = (id: string, body: WhiteboardBatchInput) => post<WhiteboardBatchResult>(`/whiteboards/${id}/elements`, body);
export const convertWhiteboard = (id: string, body: WhiteboardConvertInput) => post<WhiteboardConvertResult>(`/whiteboards/${id}/convert`, body);

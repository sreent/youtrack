/** Imports over the API: the upload is the file itself, streamed as the body; the rest is JSON. */
import type { ApiImportSource, Import, ImportBring, ImportCheck, ImportCredentials, ImportRow, ImportUndo } from '@a4a/shared';
import { useQuery } from '@tanstack/react-query';
import { api, ApiError, get, post, qs } from '../../api/client';
import { t } from '../../i18n';

export const importKeys = {
  all: ['imports'] as const,
  list: ['imports', 'list'] as const,
  one: (id: string) => ['imports', id] as const,
  rows: (id: string, status: string) => ['imports', id, 'rows', status] as const,
};

export const useImports = () => useQuery({ queryKey: importKeys.list, queryFn: () => get<Import[]>('/imports') });

/** An import, read every second while it reads from an API or runs, so its progress moves. */
export const useImport = (id: string | undefined) =>
  useQuery({
    queryKey: importKeys.one(id ?? ''),
    queryFn: () => get<Import>(`/imports/${id}`),
    enabled: Boolean(id),
    refetchInterval: (q) => (q.state.data?.status === 'running' || q.state.data?.status === 'fetching' ? 1000 : false),
  });

export const useImportRows = (id: string, status: string, enabled: boolean) =>
  useQuery({
    queryKey: importKeys.rows(id, status),
    queryFn: () => get<{ total: number; items: ImportRow[] }>(`/imports/${id}/rows${qs({ status, limit: 200 })}`),
    enabled,
  });

export async function uploadFile(file: File, project: string, source?: string): Promise<Import> {
  const res = await fetch(`/api/v1/imports${qs({ project, source, fileName: file.name })}`, {
    method: 'POST',
    headers: { 'content-type': 'text/csv', accept: 'application/json' },
    credentials: 'same-origin',
    body: file,
  });
  const body = (await res.json().catch(() => null)) as (Import & { error?: { code: string; message: string; hint?: string } }) | null;
  if (!res.ok) throw new ApiError(res.status, body?.error?.code ?? 'http_error', body?.error?.message ?? t('imports.api.theUploadFailed', { status: res.status }), body?.error?.hint);
  return body as Import;
}

export const putMapping = (id: string, body: { columns?: Record<string, string>; values?: Record<string, Record<string, string | null>>; options?: { onExisting?: 'update' | 'skip' } }) =>
  api<Import>('PUT', `/imports/${id}/mapping`, body);
export const checkImport = (id: string) => post<ImportCheck>(`/imports/${id}/check`);
export const runImport = (id: string, credentials?: ImportCredentials) => post<Import>(`/imports/${id}/run`, credentials ? { credentials } : {});
export const undoImport = (id: string, dryRun: boolean) => post<ImportUndo>(`/imports/${id}/undo`, { dryRun });

export interface FromApi {
  project: string;
  source: ApiImportSource;
  url: string;
  query: string;
  credentials: ImportCredentials;
  bring: ImportBring;
}
export const importFromApi = (body: FromApi) => post<Import>('/imports/from-api', body);
export const continueFetch = (id: string, credentials: ImportCredentials) => post<Import>(`/imports/${id}/fetch`, { credentials });

/**
 * The token given for an import from an API, held in this page's memory and nowhere else, so the
 * run can bring the files without asking again. A reload forgets it; then the run asks.
 */
const held = new Map<string, ImportCredentials>();
export const holdCredentials = (id: string, credentials: ImportCredentials) => void held.set(id, credentials);
export const heldCredentials = (id: string) => held.get(id);
export const forgetCredentials = (id: string) => void held.delete(id);

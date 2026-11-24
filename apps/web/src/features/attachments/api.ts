import type { Attachment, AttachmentLimits, TrackerEvent } from '@a4a/shared';
import { useQuery } from '@tanstack/react-query';
import { ApiError, get } from '../../api/client';
import { formatNumber, t } from '../../i18n';

export const attachmentKeys = {
  limits: ['attachments', 'limits'] as const,
  /** Under the issue's own key, so a live event about the issue refreshes its files too. */
  issue: (id: string) => ['issues', 'one', id, 'attachments'] as const,
  article: (id: string) => ['articles', 'one', id, 'attachments'] as const,
};

export const useAttachmentLimits = (enabled = true) =>
  useQuery({ queryKey: attachmentKeys.limits, queryFn: () => get<AttachmentLimits>('/attachments/limits'), staleTime: 300_000, enabled });
export const useIssueAttachments = (id: string) => useQuery({ queryKey: attachmentKeys.issue(id), queryFn: () => get<Attachment[]>(`/issues/${id}/attachments`) });
export const useArticleAttachments = (id: string) =>
  useQuery({ queryKey: attachmentKeys.article(id), queryFn: () => get<Attachment[]>(`/articles/${id}/attachments`) });

/** Where a file's bytes are, from this page: an image opens in place; `download` makes anything download. */
export function contentPath(a: Pick<Attachment, 'id'>, download = false): string {
  return `/api/v1/attachments/${a.id}/content${download ? '?download=1' : ''}`;
}

/** "12.3 KB", "4 MB": as the server says sizes, in units of 1024. */
export function formatBytes(n: number): string {
  // In the page's language, figure and unit both: "12,3 MB" in German, "12,3 Mo" in French (D49).
  if (n < 1024) return formatNumber(n, { style: 'unit', unit: 'byte', unitDisplay: 'long' });
  const units = ['kilobyte', 'megabyte', 'gigabyte'] as const;
  let v = n / 1024;
  let u = 0;
  while (v >= 1024 && u < units.length - 1) {
    v /= 1024;
    u++;
  }
  return formatNumber(v >= 10 || Number.isInteger(v) ? Math.round(v) : Math.round(v * 10) / 10, { style: 'unit', unit: units[u], unitDisplay: 'short', maximumFractionDigits: 1 });
}

/** Kinds the bytes say for sure, whatever the name says: an HTML page named .png is "html". */
const KINDS: Record<string, string> = {
  'text/html': 'html',
  'image/svg+xml': 'svg',
  'application/xml': 'xml',
  'application/pdf': 'pdf',
  'application/zip': 'zip',
  'application/gzip': 'gz',
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
};

/**
 * What kind of file it is, as people call it: "log", "pdf". The bytes decide where they can
 * (a file's type is never taken from its name); for text or unknown bytes, the name's extension.
 */
export function kindOf(name: string, contentType?: string): string {
  const sure = contentType ? KINDS[contentType.split(';')[0]!.trim()] : undefined;
  if (sure) return sure;
  const dot = name.lastIndexOf('.');
  const ext = dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
  return /^[a-z0-9]{1,5}$/.test(ext) ? ext : 'file';
}

/** Who added a file, in the actor's shape the rest of the app reads. */
export function uploaderOf(a: Attachment): TrackerEvent['actor'] {
  return { id: a.uploadedBy?.id ?? null, login: a.uploadedBy?.login ?? null, name: a.uploadedBy?.name ?? null, channel: a.channel, token: a.token, isBot: a.uploadedBy?.isBot ?? false };
}

/**
 * Upload one file, saying how far it has come. XMLHttpRequest, because fetch can't tell how
 * much of a body has gone. Resolves with the stored file, or rejects with the server's words.
 */
export function uploadFile(path: string, file: File, onProgress: (sent: number, total: number) => void, signal?: AbortSignal): Promise<Attachment> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `/api/v1${path}`);
    xhr.setRequestHeader('accept', 'application/json');
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress(e.loaded, e.total);
    };
    xhr.onload = () => {
      let body: unknown = null;
      try {
        body = JSON.parse(xhr.responseText);
      } catch {
        body = null;
      }
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve(body as Attachment);
        return;
      }
      const e = (body as { error?: { code: string; message: string; hint?: string } } | null)?.error;
      reject(new ApiError(xhr.status, e?.code ?? 'http_error', e?.message ?? t('attachments.api.theUploadFailed', { status: xhr.status }), e?.hint));
    };
    xhr.onerror = () => reject(new ApiError(0, 'network', t('attachments.api.didnTArriveTheConnection', { name: file.name }), t('attachments.api.tryAgain')));
    xhr.onabort = () => reject(new ApiError(0, 'aborted', t('attachments.api.stopped')));
    signal?.addEventListener('abort', () => xhr.abort());
    const form = new FormData();
    form.append('file', file, file.name);
    xhr.send(form);
  });
}

/**
 * Why a file won't go, before a byte of it is sent: too large for one file, or for what's
 * left of its issue's room. The server checks again; this saves a long wait for a refusal.
 */
export function refusal(file: File, limits: AttachmentLimits | undefined, used: number): string | null {
  if (!limits) return null;
  if (file.size > limits.maxBytes) return t('attachments.api.isLargerThanTheMost', { name: file.name, formatBytes: formatBytes(limits.maxBytes) });
  const room = limits.perIssueMaxBytes - used;
  if (file.size > room) return t('attachments.api.doesnTFitIsLeft', { name: file.name, formatBytes: formatBytes(Math.max(room, 0)), formatBytes2: formatBytes(limits.perIssueMaxBytes) });
  return null;
}

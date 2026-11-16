import type { AppExtension, AppExtensionPoint } from '@a4a/shared';
import { useQuery } from '@tanstack/react-query';
import { get, qs } from '../../api/client';

export const appKeys = {
  all: ['apps'] as const,
  list: ['apps', 'list'] as const,
  catalog: ['apps', 'catalog'] as const,
  runs: (name: string) => ['apps', 'runs', name] as const,
  settings: (name: string, project: string | null) => ['apps', 'settings', name, project ?? ''] as const,
  project: (key: string) => ['apps', 'project', key] as const,
  extensions: (at: AppExtensionPoint, where: AppPlace) => ['apps', 'extensions', at, where.issue ?? '', where.project ?? '', where.article ?? ''] as const,
};

/** What a widget is about: an issue, an article, a project, or nothing (the main menu, a dashboard). */
export interface AppPlace {
  issue?: string;
  project?: string;
  article?: string;
}

/** The widgets apps draw at a place, each with its signed address (D48). */
export function useAppExtensions(at: AppExtensionPoint, where: AppPlace = {}) {
  return useQuery({
    queryKey: appKeys.extensions(at, where),
    queryFn: () => get<AppExtension[]>(`/apps/extensions${qs({ at, ...where })}`),
    // Its addresses are signed for twelve hours: an hour old, it asks again.
    staleTime: 60 * 60_000,
    retry: false,
  });
}

/** A file, as base64 without its data: prefix, for a package's upload. */
export function base64Of(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).replace(/^data:[^,]*,/, ''));
    reader.onerror = () => reject(reader.error ?? new Error('The file could not be read'));
    reader.readAsDataURL(file);
  });
}

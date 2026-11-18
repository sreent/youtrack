/**
 * The trackers an import reads from over their APIs (D29, D46, D61), by name: what the import page,
 * its mapping and an issue's history call each. Products' names, the same in every language.
 */
import type { ApiImportSource } from '@a4a/shared';
import { t } from '../../i18n';

export const SOURCE_NAME: Record<ApiImportSource, string> = {
  youtrack: t('imports.fromApi.youtrack'),
  jira: t('imports.fromApi.jira'),
  github: t('imports.fromApi.githubIssues'),
  redmine: t('imports.fromApi.redmine'),
  zendesk: t('imports.fromApi.zendesk'),
  asana: t('imports.fromApi.asana'),
  clickup: t('imports.fromApi.clickup'),
};

/** A source an issue's history names, as its import recorded it; null for a file, or one it doesn't know. */
export const sourceName = (source: string | undefined): string | null => (source && source in SOURCE_NAME ? SOURCE_NAME[source as ApiImportSource] : null);

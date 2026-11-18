/**
 * What an app may do and where its widgets go, in the page's language (D48, D49). The API's `words`
 * say what it may do in English, for agents; a page says it from the permissions themselves.
 */
import type { AppExtensionPoint, AppPermissions, AppResource } from '@a4a/shared';
import { t } from '../../i18n';

/** What each permission lets an app do, as its consent shows it. */
const MAY: Record<'read' | 'write', Record<AppResource, string>> = {
  read: {
    issues: t('apps.permission.readIssues'),
    comments: t('apps.permission.readComments'),
    articles: t('apps.permission.readArticles'),
    fields: t('apps.permission.readFields'),
    time: t('apps.permission.readTime'),
  },
  write: {
    issues: t('apps.permission.writeIssues'),
    comments: t('apps.permission.writeComments'),
    articles: t('apps.permission.writeArticles'),
    fields: t('apps.permission.writeFields'),
    time: t('apps.permission.writeTime'),
  },
};

/** Each part of a4a an app reads or writes, by its name: "issues", "logged time". */
export const RESOURCE_NAMES: Record<AppResource, string> = {
  issues: t('apps.resource.issues'),
  comments: t('apps.resource.comments'),
  articles: t('apps.resource.articles'),
  fields: t('apps.resource.fields'),
  time: t('apps.resource.time'),
};

/** What permissions let an app do, one line each, reading first. */
export function mayWords(p: AppPermissions): string[] {
  return [...p.read.map((r) => MAY.read[r] ?? r), ...p.write.map((r) => MAY.write[r] ?? r)];
}

/** What an app asks for beyond what it was granted, as a sentence's list says it: "reading comments and writing logged time". */
export function moreWords(p: AppPermissions): string[] {
  return [...p.read.map((r) => t('apps.appsSection.reading', { r: RESOURCE_NAMES[r] ?? r })), ...p.write.map((r) => t('apps.appsSection.writing', { r: RESOURCE_NAMES[r] ?? r }))];
}

/** Where a widget is drawn, as the code its message selects on: each placement is worded whole. */
export const WIDGET_AT: Record<AppExtensionPoint, string> = {
  'issue-panel': 'issuePanel',
  'issue-below-summary': 'belowSummary',
  'project-settings': 'projectPage',
  'main-menu': 'menuPage',
  dashboard: 'dashboard',
  'article-panel': 'articlePanel',
};

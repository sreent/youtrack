import { t } from '../../i18n';
import { IssueList } from '../issues/IssueList';
import type { ViewProps } from './types';

/** The list: the search's issues as the issues page shows them today, a page at a time (D72). */
export default function ListView({ issues, query, chosen, onChosen, onCommand }: ViewProps) {
  return <IssueList issues={issues} label={query ? t('page.issues.issuesFound') : t('page.issues.allIssues')} chosen={chosen} onChosen={onChosen} onCommand={onCommand} />;
}

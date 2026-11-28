import { useMe } from '../../api/queries';
import { t } from '../../i18n';
import { IssueList } from '../issues/IssueList';
import { groupsOf, useFolded } from './groups';
import type { ViewProps } from './types';

/**
 * The list: the search's issues as the issues page shows them, a page at a time (D72). Grouped, each
 * group under a head that folds it, with how many the whole result holds; what's folded is each
 * person's own, kept in their browser.
 */
export default function ListView({ issues, groups, group, query, scope, chosen, onChosen, onCommand }: ViewProps) {
  const me = useMe();
  const [folded, fold] = useFolded(me.data?.id, scope, group);
  const label = query ? t('page.issues.issuesFound') : t('page.issues.allIssues');
  if (!group || !groups) return <IssueList issues={issues} label={label} chosen={chosen} onChosen={onChosen} onCommand={() => onCommand()} />;
  return (
    <IssueList
      issues={issues}
      label={t('views.list.grouped', { list: label, field: group })}
      chosen={chosen}
      onChosen={onChosen}
      onCommand={() => onCommand()}
      groups={groupsOf(group, issues, groups)}
      folded={folded}
      onFold={fold}
    />
  );
}

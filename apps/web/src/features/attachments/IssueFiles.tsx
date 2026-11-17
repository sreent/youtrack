import type { IssueDetail, Me } from '@a4a/shared';
import { useQueryClient } from '@tanstack/react-query';
import { keys } from '../../api/queries';
import { ErrorNote, Loading } from '../../components/States';
import { attachmentKeys, useAttachmentLimits, useIssueAttachments } from './api';
import { AttachmentList } from './AttachmentList';
import { t } from '../../i18n';

/** An issue's files, its comments' included: who may change the issue may add and delete them. */
/** `canEdit`: the person may change the issue (their role in its project), so add files and delete any. */
export function IssueFiles({ issue, me, canEdit }: { issue: IssueDetail; me: Me | undefined; canEdit: boolean }) {
  const qc = useQueryClient();
  const files = useIssueAttachments(issue.id);
  const limits = useAttachmentLimits();
  const mayWrite = Boolean(me?.auth.scopes.includes('write'));
  if (files.isLoading) return <Loading what="loadingLine.files" />;
  if (files.error) return <ErrorNote error={files.error} />;
  return (
    <AttachmentList
      label={t('attachments.issueFiles.files')}
      owner={issue.id}
      files={files.data ?? []}
      limits={limits.data}
      uploadPath={canEdit ? `/issues/${issue.id}/attachments` : undefined}
      // Who added a file may delete it, and so may anyone who may change the issue; both need to write.
      canDelete={(f) => canEdit || (mayWrite && f.uploadedBy?.id === me?.id)}
      onChanged={() =>
        Promise.all([qc.invalidateQueries({ queryKey: attachmentKeys.issue(issue.id) }), qc.invalidateQueries({ queryKey: keys.issueSub(issue.id, 'activity') })])
      }
    />
  );
}

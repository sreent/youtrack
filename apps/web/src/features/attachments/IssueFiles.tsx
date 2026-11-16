import type { IssueDetail, Me } from '@a4a/shared';
import { useQueryClient } from '@tanstack/react-query';
import { keys } from '../../api/queries';
import { ErrorNote, Loading } from '../../components/States';
import { attachmentKeys, useAttachmentLimits, useIssueAttachments } from './api';
import { AttachmentList } from './AttachmentList';

/** An issue's files, its comments' included: who may change the issue may add and delete them. */
export function IssueFiles({ issue, me }: { issue: IssueDetail; me: Me | undefined }) {
  const qc = useQueryClient();
  const files = useIssueAttachments(issue.id);
  const limits = useAttachmentLimits();
  const canWrite = Boolean(me?.auth.scopes.includes('write'));
  if (files.isLoading) return <Loading what="files" />;
  if (files.error) return <ErrorNote error={files.error} />;
  return (
    <AttachmentList
      label="Files"
      owner={issue.id}
      files={files.data ?? []}
      limits={limits.data}
      uploadPath={canWrite ? `/issues/${issue.id}/attachments` : undefined}
      // Who added a file may delete it, and so may anyone who may change the issue; both need to write.
      canDelete={() => canWrite}
      onChanged={() =>
        Promise.all([qc.invalidateQueries({ queryKey: attachmentKeys.issue(issue.id) }), qc.invalidateQueries({ queryKey: keys.issueSub(issue.id, 'activity') })])
      }
    />
  );
}

import { useId } from 'react';
import { IssueLink } from '../../components/Badges';
import { Icon } from '../../components/Icon';
import { Avatar } from '../../components/Who';
import { Linked } from '../common/bits';
import { ChangeLines, readChange } from '../common/ChangeLines';
import { excerpt, lowerFirst } from '../common/format';
import type { AITool } from '../common/queries';
import type { Approval } from './live';
import { t, tr } from '../../i18n';
import type { ReactNode } from 'react';

const ID_LINE = /^([A-Z][A-Z0-9]{1,9}-\d+): (.*)$/;

/** The server's preview, a line per issue ("BACK-12: State Open → Fixed; Priority …"), as pairs. */
function PreviewWell({ preview, fieldNames }: { preview: string; fieldNames: string[] }) {
  const lines = preview.split('\n').filter((l) => l.trim());
  const pairs = lines.map((line) => {
    const m = ID_LINE.exec(line);
    return m ? { id: m[1]!, rest: m[2]! } : { id: null, rest: line };
  });
  if (!pairs.some((p) => p.id)) {
    return (
      <p className="approval-well">
        <Linked text={preview} />
      </p>
    );
  }
  return (
    <dl className="approval-changes">
      {pairs.map((p, i) => {
        const parts = p.rest.split('; ');
        const changes = parts.map((c) => readChange(c, fieldNames));
        return (
          <div className="pair" key={i}>
            <dt>{p.id ? <IssueLink id={p.id} /> : t('assistant.changeCard.change')}</dt>
            <dd>{changes.every(Boolean) ? <ChangeLines changes={changes.map((c) => c!)} /> : <Linked text={p.rest} />}</dd>
          </div>
        );
      })}
    </dl>
  );
}

/**
 * A change the assistant holds for the person's yes, as Ocean's ApprovalCard: who asks and for
 * whom, exactly what it would change (the server's dry run), why, and Approve or Decline.
 */
export function ChangeCard({
  approval,
  tool,
  forName,
  asked,
  decided,
  busy,
  blocked,
  fieldNames,
  onDecide,
}: {
  approval: Approval;
  tool?: AITool;
  forName: string;
  /** What the person asked for, in their words: the reason it's asking. */
  asked?: string;
  decided?: boolean;
  busy?: boolean;
  /** Why it can't be decided here now, if it can't. */
  blocked?: string;
  fieldNames: string[];
  onDecide: (approve: boolean) => void;
}) {
  const titleId = useId();
  const what = tool ? lowerFirst(tool.title) : approval.name.replace(/_/g, ' ');
  return (
    <section className="approval" aria-labelledby={titleId}>
      <div className="approval-stripe changes" />
      <div className="approval-body">
        <div className="who">
          <Avatar kind="agent" name="assistant" />
          <span>
            <h3 className="approval-title" id={titleId}>{tr('assistant.changeCard.assistantAsksTo', { what: what })}</h3>
            <span className="who-about">{tr('assistant.changeCard.for', { forName: forName, v: tool?.destructive ? t('assistant.changeCard.itCanOverwriteWhatIs') : '' })}</span>
          </span>
        </div>
        <PreviewWell preview={approval.preview} fieldNames={fieldNames} />
        {asked ? (
          <p className="approval-why">{tr('assistant.changeCard.whyYouAsked', { t0: (c: ReactNode) => <strong>{c}</strong>, excerpt: excerpt(asked, 160) })}</p>
        ) : null}
        {decided === undefined ? (
          <>
            {blocked ? <p className="approval-note">{blocked}</p> : null}
            <div className="approval-actions">
              <button type="button" className="primary" disabled={busy || Boolean(blocked)} onClick={() => onDecide(true)}>{t('assistant.changeCard.approve')}</button>
              <button type="button" disabled={busy || Boolean(blocked)} onClick={() => onDecide(false)}>{t('assistant.changeCard.decline')}</button>
            </div>
          </>
        ) : (
          <p className="approval-done" role="status">
            {decided ? t('assistant.changeCard.youApprovedIt') : t('assistant.changeCard.youDeclinedItNothingChanged')}
          </p>
        )}
        <p className="approval-signed">{tr('assistant.changeCard.yourDecisionIsKeptWith', { el: <Icon name="audit" /> })}</p>
      </div>
    </section>
  );
}

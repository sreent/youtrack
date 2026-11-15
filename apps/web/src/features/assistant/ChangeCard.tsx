import { useId } from 'react';
import { IssueLink } from '../../components/Badges';
import { Icon } from '../../components/Icon';
import { Avatar } from '../../components/Who';
import { Linked } from '../common/bits';
import { ChangeLines, readChange } from '../common/ChangeLines';
import { excerpt, lowerFirst } from '../common/format';
import type { AITool } from '../common/queries';
import type { Approval } from './live';

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
      <p className="a4p-well">
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
            <dt>{p.id ? <IssueLink id={p.id} /> : 'Change'}</dt>
            <dd>
              {changes.every(Boolean) ? (
                <ChangeLines changes={changes.map((c) => c!)} />
              ) : (
                <Linked text={p.rest} />
              )}
            </dd>
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
  fieldNames: string[];
  onDecide: (approve: boolean) => void;
}) {
  const titleId = useId();
  const what = tool ? lowerFirst(tool.title) : approval.name.replace(/_/g, ' ');
  return (
    <section className="approval a4p-ask" aria-labelledby={titleId}>
      <div className="approval-stripe changes" />
      <div className="approval-body">
        <div className="who">
          <Avatar kind="agent" name="assistant" />
          <span>
            <h3 className="approval-title" id={titleId}>
              assistant asks to {what}
            </h3>
            <span className="who-about">
              for {forName}
              {tool?.destructive ? ' · it can overwrite what is there' : ''}
            </span>
          </span>
        </div>
        <PreviewWell preview={approval.preview} fieldNames={fieldNames} />
        {asked ? (
          <p className="approval-why">
            <strong>Why: </strong>you asked “{excerpt(asked, 160)}”
          </p>
        ) : null}
        {decided === undefined ? (
          <div className="approval-actions">
            <button type="button" className="primary" disabled={busy} onClick={() => onDecide(true)}>
              Approve
            </button>
            <button type="button" disabled={busy} onClick={() => onDecide(false)}>
              Decline
            </button>
          </div>
        ) : (
          <p className="approval-done" role="status">
            {decided ? 'You approved it.' : 'You declined it. Nothing changed.'}
          </p>
        )}
        <p className="approval-signed">
          <Icon name="audit" />
          Your decision is kept with this conversation, and any change in the issue's history.
        </p>
      </div>
    </section>
  );
}

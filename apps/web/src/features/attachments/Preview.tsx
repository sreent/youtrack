import type { Attachment, AttachmentText } from '@a4a/shared';
import { useQuery } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';
import { get } from '../../api/client';
import { ErrorLine, Loading } from '../../components/States';
import { errorText } from '../issues/api';
import { contentPath, formatBytes } from './api';
import { t as tx, tr } from '../../i18n';

/** How much of a text file shows at once (the server reads 128 KB at most). */
export const PREVIEW_BYTES = 64 * 1024;

/** Whether the page shows this file in place: text, or sound and video a browser plays. Images open as themselves. */
export const previewable = (f: Attachment) => !f.inline && (f.text || f.play !== null);

// Characters that change the direction text reads in, which could make a line say what it doesn't
// ("txt.exe" read as "exe.txt"): shown by their code instead.
const TURNS = /([؜‎‏‪-‮⁦-⁩])/;

function withMarks(text: string): ReactNode[] {
  return text.split(TURNS).map((part, i) =>
    i % 2 ? (
      <span key={i} className="attachment-mark" title={tx('attachments.preview.aCharacterThatChangesThe')}>{tr('attachments.preview.u', { padStart: part.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0') })}</span>
    ) : (
      part
    ),
  );
}

/** Ocean's AttachmentList preview for text: as it's written, its start or its end, in a frame of its own. */
function TextPreview({ file, id }: { file: Attachment; id: string }) {
  const [end, setEnd] = useState(false);
  const part = useQuery({
    queryKey: ['attachments', file.id, 'text', end ? 'end' : 'start'],
    queryFn: () => get<AttachmentText>(`/attachments/${file.id}/text?maxBytes=${PREVIEW_BYTES}${end ? '&tail=true' : ''}`),
    // A file's bytes never change under its id.
    staleTime: Infinity,
  });
  const download = (
    <a href={contentPath(file, true)} download={file.name}>{tx('attachments.preview.downloadIt')}</a>
  );
  if (part.isLoading) {
    return (
      <div className="attachment-preview" id={id}>
        <Loading named={file.name} />
      </div>
    );
  }
  if (part.error || !part.data) {
    return (
      <div className="attachment-preview" id={id}>
        <ErrorLine>{errorText(part.error, tx('attachments.preview.canTBeShownHere', { name: file.name }))}</ErrorLine>
        <p className="attachment-preview-about">{download}</p>
      </div>
    );
  }
  const t = part.data;
  if (!t.size) {
    return (
      <div className="attachment-preview" id={id}>
        <p className="attachment-preview-about">
          <span>{tx('attachments.preview.itSEmpty')}</span>
        </p>
      </div>
    );
  }
  const shown = formatBytes(t.to - t.from);
  const which = !t.truncated ? null : end ? tx('attachments.preview.theLastOf', { shown: shown, formatBytes: formatBytes(t.size) }) : tx('attachments.preview.theFirstOf', { shown: shown, formatBytes: formatBytes(t.size) });
  return (
    <div className="attachment-preview" id={id}>
      {/* Its own frame scrolls, so the keyboard can reach it. */}
      <pre className="attachment-text" tabIndex={0} aria-label={which ? tx(end ? 'attachments.preview.nameItsLast' : 'attachments.preview.nameItsFirst', { name: file.name, size: shown }) : file.name}>
        {withMarks(t.text)}
      </pre>
      <p className="attachment-preview-about">
        {which ? <span>{which}</span> : null}
        {which ? (
          <button type="button" className="link" onClick={() => setEnd((e) => !e)}>
            {end ? tx('attachments.preview.showTheStart') : tx('attachments.preview.showTheEnd')}
          </button>
        ) : null}
        {download}
      </p>
    </div>
  );
}

/** Sound or video in the browser's own player; if this browser can't play it after all, it says so. */
function Player({ file, id }: { file: Attachment; id: string }) {
  const [failed, setFailed] = useState(false);
  const src = contentPath(file);
  return (
    <div className="attachment-preview" id={id}>
      {file.play === 'video' ? (
        <video controls preload="metadata" src={src} aria-label={file.name} onError={() => setFailed(true)} />
      ) : (
        <audio controls preload="metadata" src={src} aria-label={file.name} onError={() => setFailed(true)} />
      )}
      {failed ? (
        <ErrorLine>{tr('attachments.preview.thisBrowserCanTPlay', { name: file.name, t0: (c: ReactNode) => <a href={contentPath(file, true)} download={file.name}>{c}</a> })}</ErrorLine>
      ) : null}
    </div>
  );
}

/** A file shown in place, under its row: text, or a player. */
export function Preview({ file, id }: { file: Attachment; id: string }) {
  return file.play ? <Player file={file} id={id} /> : <TextPreview file={file} id={id} />;
}

import type { Attachment, AttachmentText } from '@a4a/shared';
import { useQuery } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';
import { get } from '../../api/client';
import { ErrorLine, Loading } from '../../components/States';
import { errorText } from '../issues/api';
import { contentPath, formatBytes } from './api';

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
      <span key={i} className="attachment-mark" title="A character that changes the direction text reads in">
        U+{part.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0')}
      </span>
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
    <a href={contentPath(file, true)} download={file.name}>
      Download it
    </a>
  );
  if (part.isLoading) {
    return (
      <div className="attachment-preview" id={id}>
        <Loading what={file.name} />
      </div>
    );
  }
  if (part.error || !part.data) {
    return (
      <div className="attachment-preview" id={id}>
        <ErrorLine>{errorText(part.error, `${file.name} can't be shown here.`)}</ErrorLine>
        <p className="attachment-preview-about">{download}</p>
      </div>
    );
  }
  const t = part.data;
  if (!t.size) {
    return (
      <div className="attachment-preview" id={id}>
        <p className="attachment-preview-about">
          <span>It's empty.</span>
        </p>
      </div>
    );
  }
  const shown = formatBytes(t.to - t.from);
  const which = !t.truncated ? null : end ? `The last ${shown} of ${formatBytes(t.size)}.` : `The first ${shown} of ${formatBytes(t.size)}.`;
  return (
    <div className="attachment-preview" id={id}>
      {/* Its own frame scrolls, so the keyboard can reach it. */}
      <pre className="attachment-text" tabIndex={0} aria-label={which ? `${file.name}, ${end ? 'its last' : 'its first'} ${shown}` : file.name}>
        {withMarks(t.text)}
      </pre>
      <p className="attachment-preview-about">
        {which ? <span>{which}</span> : null}
        {which ? (
          <button type="button" className="link" onClick={() => setEnd((e) => !e)}>
            {end ? 'Show the start' : 'Show the end'}
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
        <ErrorLine>
          This browser can't play {file.name}.{' '}
          <a href={contentPath(file, true)} download={file.name}>
            Download it
          </a>{' '}
          to play it elsewhere.
        </ErrorLine>
      ) : null}
    </div>
  );
}

/** A file shown in place, under its row: text, or a player. */
export function Preview({ file, id }: { file: Attachment; id: string }) {
  return file.play ? <Player file={file} id={id} /> : <TextPreview file={file} id={id} />;
}

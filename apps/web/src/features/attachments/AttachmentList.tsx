import type { Attachment, AttachmentLimits } from '@a4a/shared';
import { useId, useRef, useState } from 'react';
import { del } from '../../api/client';
import { Icon } from '../../components/Icon';
import { ErrorLine } from '../../components/States';
import { actorWho, Who } from '../../components/Who';
import { Said } from '../common/bits';
import { Confirm } from '../common/Confirm';
import { whenRead } from '../common/format';
import { errorText } from '../issues/api';
import { contentPath, formatBytes, kindOf, refusal, uploaderOf, uploadFile } from './api';

interface Upload {
  key: string;
  file: File;
  sent: number;
  total: number;
  error: string | null;
  stop: AbortController;
}

/** A file's mark: its own picture when it's an image, else the attach mark and its kind. */
function Thumb({ file }: { file: Attachment }) {
  if (file.inline) {
    return (
      // The name beside it is the way in for the keyboard and screen readers; this is for the pointer.
      <a className="attachment-thumb" href={contentPath(file)} target="_blank" rel="noopener" tabIndex={-1} aria-hidden="true">
        <img src={contentPath(file)} alt="" loading="lazy" decoding="async" />
      </a>
    );
  }
  return (
    <span className="attachment-thumb" aria-hidden="true">
      <Icon name="attach" />
      <span className="attachment-kind">{kindOf(file.name, file.contentType)}</span>
    </span>
  );
}

function FileName({ file }: { file: Attachment }) {
  return file.inline ? (
    <a className="attachment-name" href={contentPath(file)} target="_blank" rel="noopener">
      {file.name}
    </a>
  ) : (
    <a className="attachment-name" href={contentPath(file, true)} download={file.name}>
      {file.name}
    </a>
  );
}

/** A comment's own files, under its words: smaller, without who and when, which the comment says. */
export function CommentFiles({ files }: { files: Attachment[] }) {
  if (!files.length) return null;
  return (
    <ul className="attachment-list compact" aria-label="Files on this comment">
      {files.map((f) => (
        <li key={f.id} className="attachment">
          <Thumb file={f} />
          <div className="attachment-what">
            <FileName file={f} />
            <span className="attachment-about">
              <span>{formatBytes(f.size)}</span>
            </span>
          </div>
        </li>
      ))}
    </ul>
  );
}

/**
 * Ocean's AttachmentList: the files on an issue or an article, each by its picture or its kind,
 * with its size, who added it and when; files on their way, with how far they've come; and a
 * place to drop more, or choose them. Deleting asks first.
 */
export function AttachmentList({
  label,
  owner,
  files,
  limits,
  uploadPath,
  canDelete,
  onChanged,
}: {
  label: string;
  /** What they're on, for what's said about them: "BACK-12". */
  owner: string;
  files: Attachment[];
  limits?: AttachmentLimits;
  /** Where new files go; none, and nobody here may add any. */
  uploadPath?: string;
  canDelete: (file: Attachment) => boolean;
  onChanged: () => unknown;
}) {
  const titleId = useId();
  const noteId = useId();
  const input = useRef<HTMLInputElement>(null);
  const queue = useRef<Promise<void>>(Promise.resolve());
  const [uploads, setUploads] = useState<Upload[]>([]);
  const [over, setOver] = useState(false);
  const [said, setSaid] = useState<string | null>(null);
  const [failed, setFailed] = useState<string | null>(null);

  const used = files.reduce((n, f) => n + f.size, 0);
  const update = (key: string, patch: Partial<Upload>) => setUploads((list) => list.map((u) => (u.key === key ? { ...u, ...patch } : u)));
  const drop = (key: string) => setUploads((list) => list.filter((u) => u.key !== key));

  const send = async (row: Upload) => {
    if (!uploadPath || row.stop.signal.aborted) return;
    try {
      await uploadFile(uploadPath, row.file, (sent, total) => update(row.key, { sent, total }), row.stop.signal);
      drop(row.key);
      setSaid(`${row.file.name} is attached to ${owner}.`);
      await onChanged();
    } catch (e) {
      if (row.stop.signal.aborted) {
        drop(row.key);
        setSaid(`${row.file.name} wasn't attached.`);
      } else update(row.key, { error: errorText(e, `${row.file.name} wasn't attached.`) });
    }
  };

  const add = (list: File[]) => {
    if (!uploadPath || !list.length) return;
    let ahead = used + uploads.filter((u) => !u.error).reduce((n, u) => n + u.file.size, 0);
    const rows = list.map((file) => {
      const error = refusal(file, limits, ahead);
      if (!error) ahead += file.size;
      return { key: `${file.name}-${file.size}-${Math.random().toString(36).slice(2)}`, file, sent: 0, total: file.size, error, stop: new AbortController() };
    });
    setUploads((current) => [...current, ...rows]);
    setSaid(null);
    for (const row of rows) if (!row.error) queue.current = queue.current.then(() => send(row));
  };

  const remove = async (file: Attachment) => {
    setFailed(null);
    try {
      await del(`/attachments/${file.id}`);
      setSaid(`${file.name} is gone.`);
      await onChanged();
    } catch (e) {
      setFailed(errorText(e));
    }
  };

  const max = limits ? formatBytes(limits.maxBytes) : null;
  return (
    <section
      className="card attachments"
      aria-labelledby={titleId}
      onDragOver={(e) => {
        if (!uploadPath || !e.dataTransfer.types.includes('Files')) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'copy';
        setOver(true);
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOver(false);
      }}
      onDrop={(e) => {
        if (!uploadPath) return;
        e.preventDefault();
        setOver(false);
        add([...e.dataTransfer.files]);
      }}
    >
      <div className="section-head">
        <h2 id={titleId}>{label}</h2>
        {files.length ? (
          <p className="note">
            {files.length === 1 ? '1 file' : `${files.length} files`}, {formatBytes(used)}
            {limits ? ` of ${formatBytes(limits.perIssueMaxBytes)}` : ''}
          </p>
        ) : null}
      </div>
      {files.length || uploads.length ? (
        <ul className="attachment-list">
          {files.map((f) => {
            const who = actorWho(uploaderOf(f));
            return (
              <li key={f.id} className="attachment">
                <Thumb file={f} />
                <div className="attachment-what">
                  <FileName file={f} />
                  <span className="attachment-about">
                    <span>{formatBytes(f.size)}</span>
                    <Who kind={who.kind} name={who.name} about={who.about || undefined} small />
                    {f.comment ? <a href={`#comment-${f.comment}`}>on a comment</a> : null}
                    <time dateTime={f.createdAt} title={new Date(f.createdAt).toLocaleString()}>
                      {whenRead(f.createdAt)}
                    </time>
                  </span>
                </div>
                {canDelete(f) ? (
                  <div className="attachment-actions">
                    <Confirm
                      small
                      label="Delete"
                      name={`Delete ${f.name}`}
                      title={`Delete ${f.name}?`}
                      about={`It goes from ${owner} for good, and nobody can bring it back.`}
                      confirm="Delete it"
                      onConfirm={() => void remove(f)}
                    />
                  </div>
                ) : null}
              </li>
            );
          })}
          {uploads.map((u) => (
            <li key={u.key} className={u.error ? 'attachment failed' : 'attachment uploading'}>
              <span className="attachment-thumb" aria-hidden="true">
                <Icon name="attach" />
                <span className="attachment-kind">{kindOf(u.file.name)}</span>
              </span>
              <div className="attachment-what">
                <span className="attachment-name">{u.file.name}</span>
                {u.error ? null : (
                  <progress className="attachment-progress" max={u.total || 1} value={u.sent} aria-label={`Attaching ${u.file.name}`}>
                    {Math.round((u.sent / (u.total || 1)) * 100)}%
                  </progress>
                )}
                <span className="attachment-about">{u.error ? formatBytes(u.file.size) : `${formatBytes(u.sent)} of ${formatBytes(u.total)}`}</span>
              </div>
              <div className="attachment-actions">
                {u.error ? (
                  <button type="button" className="small" onClick={() => drop(u.key)} aria-label={`Dismiss ${u.file.name}`}>
                    Dismiss
                  </button>
                ) : (
                  <button type="button" className="small" onClick={() => u.stop.abort()} aria-label={`Stop attaching ${u.file.name}`}>
                    Stop
                  </button>
                )}
              </div>
              {u.error ? <ErrorLine>{u.error}</ErrorLine> : null}
            </li>
          ))}
        </ul>
      ) : uploadPath ? null : (
        <p className="note">No files.</p>
      )}
      {failed ? <ErrorLine>{failed}</ErrorLine> : null}
      {uploadPath ? (
        <>
          {files.length || uploads.length || over ? (
            <div className="attachment-drop" data-over={over ? 'true' : undefined}>
              <Icon name="attach" />
              <p>
                {over ? (
                  'Drop them to attach them'
                ) : (
                  <>
                    Drop files here to attach them, or{' '}
                    <button type="button" className="link" onClick={() => input.current?.click()} aria-describedby={noteId}>
                      choose files
                    </button>
                  </>
                )}
              </p>
              <p className="note" id={noteId}>
                {max ? `Up to ${max} each. ` : ''}Images show here; everything else downloads.
              </p>
            </div>
          ) : (
            // Nothing here yet: a line, not a box, until a file is dragged over.
            <p className="note" id={noteId}>
              None yet. Drop files here, or{' '}
              <button type="button" className="link" onClick={() => input.current?.click()}>
                choose files
              </button>
              {max ? `, up to ${max} each` : ''}.
            </p>
          )}
          <input
            ref={input}
            type="file"
            multiple
            hidden
            onChange={(e) => {
              add([...(e.target.files ?? [])]);
              e.target.value = '';
            }}
          />
        </>
      ) : null}
      <Said text={said} />
    </section>
  );
}

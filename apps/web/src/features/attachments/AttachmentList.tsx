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
import { Preview, previewable } from './Preview';
import { intlLocale, t, tr } from '../../i18n';

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
    <ul className="attachment-list compact" aria-label={t('attachments.attachmentList.filesOnThisComment')}>
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
  // Files shown in place: none until asked for, so a long list stays quiet.
  const [shown, setShown] = useState<ReadonlySet<string>>(() => new Set());
  const toggle = (id: string) =>
    setShown((s) => {
      const next = new Set(s);
      if (!next.delete(id)) next.add(id);
      return next;
    });

  const used = files.reduce((n, f) => n + f.size, 0);
  const update = (key: string, patch: Partial<Upload>) => setUploads((list) => list.map((u) => (u.key === key ? { ...u, ...patch } : u)));
  const drop = (key: string) => setUploads((list) => list.filter((u) => u.key !== key));

  const send = async (row: Upload) => {
    if (!uploadPath || row.stop.signal.aborted) return;
    try {
      await uploadFile(uploadPath, row.file, (sent, total) => update(row.key, { sent, total }), row.stop.signal);
      drop(row.key);
      setSaid(t('attachments.attachmentList.isAttachedTo', { name: row.file.name, owner: owner }));
      await onChanged();
    } catch (e) {
      if (row.stop.signal.aborted) {
        drop(row.key);
        setSaid(t('attachments.attachmentList.wasnTAttached', { name: row.file.name }));
      } else update(row.key, { error: errorText(e, t('attachments.attachmentList.wasnTAttached', { name: row.file.name })) });
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
      setSaid(t('attachments.attachmentList.isGone', { name: file.name }));
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
            {files.length === 1 ? t('attachments.attachmentList.n1File') : t('attachments.attachmentList.files', { length: files.length })}, {formatBytes(used)}
            {limits ? t('attachments.attachmentList.of', { formatBytes: formatBytes(limits.perIssueMaxBytes) }) : ''}
          </p>
        ) : null}
      </div>
      {files.length || uploads.length ? (
        <ul className="attachment-list">
          {files.map((f) => {
            const who = actorWho(uploaderOf(f));
            const canShow = previewable(f);
            const open = canShow && shown.has(f.id);
            const previewId = `${titleId}-${f.id}`;
            return (
              <li key={f.id} className="attachment">
                <Thumb file={f} />
                <div className="attachment-what">
                  <FileName file={f} />
                  <span className="attachment-about">
                    <span>{formatBytes(f.size)}</span>
                    <Who kind={who.kind} name={who.name} about={who.about || undefined} small />
                    {f.comment ? <a href={`#comment-${f.comment}`}>{t('attachments.attachmentList.onAComment')}</a> : null}
                    <time dateTime={f.createdAt} title={new Date(f.createdAt).toLocaleString(intlLocale())}>
                      {whenRead(f.createdAt)}
                    </time>
                  </span>
                </div>
                {canShow || canDelete(f) ? (
                  <div className="attachment-actions">
                    {canShow ? (
                      <button
                        type="button"
                        className="small"
                        aria-expanded={open}
                        aria-controls={open ? previewId : undefined}
                        aria-label={`${open ? t('attachments.attachmentList.hide') : t('attachments.attachmentList.show')} ${f.name}`}
                        onClick={() => toggle(f.id)}
                      >
                        {open ? t('attachments.attachmentList.hide') : t('attachments.attachmentList.show')}
                      </button>
                    ) : null}
                    {canDelete(f) ? (
                      <Confirm
                        small
                        label={t('attachments.attachmentList.delete')}
                        name={t('attachments.attachmentList.delete3', { name: f.name })}
                        title={t('attachments.attachmentList.delete2', { name: f.name })}
                        about={t('attachments.attachmentList.itGoesFromForGood', { owner: owner })}
                        confirm={t('attachments.attachmentList.deleteIt')}
                        onConfirm={() => void remove(f)}
                      />
                    ) : null}
                  </div>
                ) : null}
                {open ? <Preview file={f} id={previewId} /> : null}
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
                  <progress className="attachment-progress" max={u.total || 1} value={u.sent} aria-label={t('attachments.attachmentList.attaching', { name: u.file.name })}>
                    {Math.round((u.sent / (u.total || 1)) * 100)}%
                  </progress>
                )}
                <span className="attachment-about">{u.error ? formatBytes(u.file.size) : t('attachments.attachmentList.of2', { formatBytes: formatBytes(u.sent), formatBytes2: formatBytes(u.total) })}</span>
              </div>
              <div className="attachment-actions">
                {u.error ? (
                  <button type="button" className="small" onClick={() => drop(u.key)} aria-label={t('attachments.attachmentList.dismiss', { name: u.file.name })}>{t('attachments.attachmentList.dismiss2')}</button>
                ) : (
                  <button type="button" className="small" onClick={() => u.stop.abort()} aria-label={t('attachments.attachmentList.stopAttaching', { name: u.file.name })}>{t('attachments.attachmentList.stop')}</button>
                )}
              </div>
              {u.error ? <ErrorLine>{u.error}</ErrorLine> : null}
            </li>
          ))}
        </ul>
      ) : uploadPath ? null : (
        <p className="note">{t('attachments.attachmentList.noFiles')}</p>
      )}
      {failed ? <ErrorLine>{failed}</ErrorLine> : null}
      {uploadPath ? (
        <>
          {files.length || uploads.length || over ? (
            <div className="attachment-drop" data-over={over ? 'true' : undefined}>
              <Icon name="attach" />
              <p>
                {over ? (
                  t('attachments.attachmentList.dropThemToAttachThem')
                ) : (
                  <>{tr('attachments.attachmentList.dropFilesHereToAttach', { el: <button type="button" className="link" onClick={() => input.current?.click()} aria-describedby={noteId}>{t('attachments.attachmentList.chooseFiles')}</button> })}</>
                )}
              </p>
              <p className="note" id={noteId}>{tr('attachments.attachmentList.imagesTextSoundAndVideo', { v: max ? t('attachments.attachmentList.upToEach', { max: max }) : '' })}</p>
            </div>
          ) : (
            // Nothing here yet: a line, not a box, until a file is dragged over.
            <p className="note" id={noteId}>{tr('attachments.attachmentList.noneYetDropFilesHere', { el: <button type="button" className="link" onClick={() => input.current?.click()}>{t('attachments.attachmentList.chooseFiles')}</button>, v: max ? t('attachments.attachmentList.upToEach2', { max: max }) : '' })}</p>
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

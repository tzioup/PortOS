import { useEffect, useState } from 'react';
import { Download, FileText, Loader2, Lock, LockOpen, Paperclip, Video } from 'lucide-react';
import toast from '../../ui/Toast';
import { useLockToggle } from '../../../hooks/useLockToggle';
import { formatBytes } from '../../../utils/formatters';
import {
  beeperAttachmentUrl, fetchBeeperAttachment, setBeeperAttachmentKeep,
} from '../../../services/api';

/**
 * One attachment inside a mirrored Beeper message (#37, decided on #13).
 *
 * **The `<img>` IS the lazy mirror.** `beeperAttachmentUrl` points at an
 * authenticated `/api/beeper/...` route that fetches the bytes from Beeper on a
 * miss and serves them from disk afterwards, so `loading="lazy"` is the whole
 * "download on first human view" rule: nothing is transferred for a thread
 * nobody scrolls to, and nothing needs a second mechanism to decide when a
 * view happened. A bulk backfill exists, but it is a user action behind a
 * consent step in the settings drawer, never something a render kicks off.
 *
 * Four states, and none of them is a spinner over an empty box:
 *
 *  - **Over cap.** A known size above the 32 MiB ceiling renders a labelled
 *    placeholder that NAMES the size and offers "Fetch anyway". The row is
 *    never dropped — #13 is explicit that an over-cap attachment keeps its
 *    metadata and its escape hatch.
 *  - **Unavailable.** Beeper answers `502` for media the source network has
 *    aged out; the mirror stamps that as terminal, so this renders the
 *    reference and says why rather than retrying on every paint.
 *  - **Failed to load.** Any other fetch failure degrades to the same
 *    reference-only row — an attachment that cannot be shown is still a fact
 *    about the conversation.
 *  - **Video renders a generic tile** rather than an inline player: the
 *    mirror has no poster frame (`posterImg` was populated on zero attachments
 *    in the live probe) and autoplaying a 30 MB file inside a thread is not
 *    what opening a chat should cost.
 *
 * The `keep` lock is the per-attachment exemption from least-recently-viewed
 * eviction — the shared `useLockToggle` optimistic-PATCH shape, so it behaves
 * like every other lock in PortOS.
 */

const isImage = (mimeType) => String(mimeType || '').startsWith('image/') && !String(mimeType).includes('svg');
const isVideo = (mimeType) => String(mimeType || '').startsWith('video/');

const sizeLabel = (bytes) => (bytes === null || bytes === undefined ? 'size unknown' : formatBytes(bytes));

function KeepButton({ attachment, busy, onToggle }) {
  const locked = attachment.keep === true;
  return (
    <button
      type="button"
      disabled={busy}
      onClick={() => onToggle(locked)}
      title={locked
        ? 'Kept — exempt from the attachment budget’s eviction'
        : 'Keep these bytes even when the attachment budget evicts older ones'}
      aria-label={locked ? 'Stop keeping this attachment' : 'Keep this attachment'}
      className="inline-flex min-h-[24px] shrink-0 items-center rounded px-1 text-gray-400 transition-colors hover:text-port-accent disabled:opacity-40"
    >
      {busy ? <Loader2 size={11} className="animate-spin" /> : (locked ? <Lock size={11} className="text-port-accent" /> : <LockOpen size={11} />)}
    </button>
  );
}

/** The reference-only row — the honest fallback for every state without bytes. */
function ReferenceRow({ attachment, note, action, keepControl }) {
  return (
    <div className="mt-1 rounded border border-dashed border-port-border px-2 py-1.5 text-[11px] text-gray-400">
      <div className="flex items-center gap-1.5">
        <Paperclip size={11} className="shrink-0" />
        <span className="min-w-0 flex-1 truncate">
          {attachment.fileName || attachment.mimeType || 'Attachment'}
        </span>
        <span className="shrink-0 text-gray-500">{sizeLabel(attachment.byteLength)}</span>
        {keepControl}
      </div>
      {note && <p className="pt-1 text-[10px] text-gray-500">{note}</p>}
      {action}
    </div>
  );
}

export default function BeeperAttachment({ attachment, onUpdated }) {
  // Local state so a successful "Fetch anyway" swaps the placeholder for the
  // real thing immediately, rather than waiting on a thread refetch (the
  // client convention: update local state after a mutation).
  const [row, setRow] = useState(attachment);
  const [fetching, setFetching] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);
  useEffect(() => {
    setRow(attachment);
    setLoadFailed(false);
  }, [attachment]);

  const applyUpdate = (updated) => {
    setRow(updated);
    onUpdated?.(updated);
  };

  const { busy: keepBusy, toggle: toggleKeep } = useLockToggle({
    patchFn: (next) => setBeeperAttachmentKeep(row.messageId, row.idx, next, { silent: true }),
    onSuccess: (updated) => applyUpdate(updated),
    lockedMessage: 'Attachment kept — the budget will not evict it',
    unlockedMessage: 'Attachment no longer kept',
    errorMessage: 'Could not update the attachment lock',
  });
  const keepControl = <KeepButton attachment={row} busy={keepBusy} onToggle={toggleKeep} />;

  const url = beeperAttachmentUrl(row.messageId, row.idx);

  const handleForceFetch = async () => {
    setFetching(true);
    const updated = await fetchBeeperAttachment(row.messageId, row.idx, { silent: true })
      .catch((err) => {
        toast.error(err?.message || 'Could not fetch this attachment');
        return null;
      });
    setFetching(false);
    if (!updated) return;
    setLoadFailed(false);
    applyUpdate(updated);
  };

  // Over cap and not yet mirrored: the placeholder names the cost before the
  // user decides to pay it.
  if (row.overCap && !row.stored) {
    return (
      <ReferenceRow
        attachment={row}
        keepControl={keepControl}
        note={`Larger than the ${formatBytes(row.maxBytes)} mirror limit — not downloaded automatically.`}
        action={(
          <button
            type="button"
            onClick={handleForceFetch}
            disabled={fetching}
            className="mt-1 inline-flex min-h-[28px] items-center gap-1.5 rounded border border-port-border px-2 text-[11px] text-gray-200 transition-colors hover:border-port-accent disabled:opacity-40"
          >
            {fetching ? <Loader2 size={11} className="animate-spin" /> : <Download size={11} />}
            Fetch anyway
          </button>
        )}
      />
    );
  }

  if (row.unavailable && !row.stored) {
    return (
      <ReferenceRow
        attachment={row}
        keepControl={keepControl}
        note="Beeper can no longer supply this file — the network it came from has aged it out."
      />
    );
  }

  if (loadFailed) {
    return (
      <ReferenceRow
        attachment={row}
        keepControl={keepControl}
        note="Could not load these bytes from Beeper right now."
        action={(
          <button
            type="button"
            onClick={handleForceFetch}
            disabled={fetching}
            className="mt-1 inline-flex min-h-[28px] items-center gap-1.5 rounded border border-port-border px-2 text-[11px] text-gray-200 transition-colors hover:border-port-accent disabled:opacity-40"
          >
            {fetching ? <Loader2 size={11} className="animate-spin" /> : <Download size={11} />}
            Retry
          </button>
        )}
      />
    );
  }

  if (isImage(row.mimeType)) {
    return (
      <div className="mt-1">
        <img
          src={url}
          alt={row.fileName || 'Attachment'}
          loading="lazy"
          onError={() => setLoadFailed(true)}
          className="max-h-64 w-auto max-w-full rounded-lg border border-port-border object-contain"
        />
        <div className="flex items-center gap-1.5 pt-0.5 text-[10px] text-gray-500">
          <span className="min-w-0 flex-1 truncate">{row.fileName || row.mimeType}</span>
          <span className="shrink-0">{sizeLabel(row.byteLength)}</span>
          {keepControl}
        </div>
      </div>
    );
  }

  // Video and everything else: a generic tile that names the file and opens it
  // on demand. The link is what triggers the mirror for these — nothing is
  // downloaded just because the thread scrolled past.
  const Icon = isVideo(row.mimeType) ? Video : FileText;
  return (
    <div className="mt-1 flex items-center gap-1.5 rounded border border-port-border bg-port-bg/40 px-2 py-1.5 text-[11px] text-gray-300">
      <Icon size={13} className="shrink-0 text-gray-400" />
      <a
        href={url}
        target="_blank"
        rel="noreferrer"
        className="min-w-0 flex-1 truncate transition-colors hover:text-port-accent"
      >
        {row.fileName || (isVideo(row.mimeType) ? 'Video' : row.mimeType || 'Attachment')}
      </a>
      <span className="shrink-0 text-gray-500">{sizeLabel(row.byteLength)}</span>
      {keepControl}
    </div>
  );
}

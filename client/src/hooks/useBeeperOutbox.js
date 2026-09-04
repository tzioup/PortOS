import { useCallback, useEffect, useRef, useState } from 'react';
import toast from '../components/ui/Toast';
import { createOutboxEntry, listOutboxEntries, sendOutboxEntry } from '../services/apiBeeper';
import useBeeperRealtime from './useBeeperRealtime';
import useMounted from './useMounted';

/**
 * The Beeper composer's send lifecycle (#36, decided on #8).
 *
 * Two server steps, deliberately: `POST /api/beeper/outbox` writes the durable
 * row from the typed body, then `POST /api/beeper/outbox/:id/send` performs the
 * send. This hook drives both from one `submit(body)` so the composer stays a
 * text box with a button, while the row exists on disk before anything is sent.
 *
 * Three rules it exists to keep:
 *
 *  - **Nothing here ever retries.** Beeper has no idempotency key on send, so a
 *    retry is a second real message. A failed send stays failed and visible in
 *    `entries`; sending again means composing again, which creates a NEW row.
 *  - **First contact confirms inline.** The server refuses the first outbound
 *    message to a conversation with `FIRST_CONTACT_CONFIRMATION_REQUIRED`;
 *    that answer is surfaced as `confirmation`, NOT as an error toast, so the
 *    composer can render an `InlineConfirmRow` (never `window.confirm`, which
 *    client conventions forbid). `confirmAndSend()` re-sends the SAME row with
 *    the flag — it does not create a second one.
 *  - **Confirmation is the server's business.** A sent row sits in
 *    `awaiting-confirmation` until the socket or the 30s fallback resolves it;
 *    this hook just refetches when an invalidation says the mirror moved.
 *
 * @param {string|null} conversationId the open conversation (a route param).
 * @param {object} [options]
 * @param {() => void} [options.onSent] called after a send is accepted, so the
 *   composer can clear its draft buffer.
 */
export default function useBeeperOutbox(conversationId, { onSent } = {}) {
  const [entries, setEntries] = useState([]);
  const [sending, setSending] = useState(false);
  // `null` = no confirmation pending. When set it carries the entry the user is
  // being asked about, so confirming re-sends that row rather than a new one.
  const [confirmation, setConfirmation] = useState(null);
  const [error, setError] = useState(null);
  const mountedRef = useMounted();
  const onSentRef = useRef(onSent);
  onSentRef.current = onSent;

  const refresh = useCallback(async () => {
    if (!conversationId) {
      setEntries([]);
      return;
    }
    const result = await listOutboxEntries(conversationId, { silent: true }).catch(() => null);
    if (!mountedRef.current) return;
    // A failed GET leaves the list alone rather than blanking it — absent is
    // not the same as empty, and an emptied list would hide a failed send.
    if (Array.isArray(result?.entries)) setEntries(result.entries);
  }, [conversationId]);

  useEffect(() => {
    setConfirmation(null);
    setError(null);
    refresh();
  }, [refresh]);

  // A send confirms server-side (socket `message.upserted`, or the 30s GET
  // fallback), and the server re-broadcasts an id-only invalidation when it
  // lands. That is the cue to refetch the outbox — no polling, no timers here.
  const awaitingRef = useRef(false);
  awaitingRef.current = entries.some((entry) => entry.state === 'awaiting-confirmation' || entry.state === 'sending');
  useBeeperRealtime({
    onInvalidate: (frame) => {
      if (frame?.kind !== 'message.upserted' || !awaitingRef.current) return;
      refresh();
    },
  });

  /** Send one existing row. Shared by the first attempt and the confirmation. */
  const dispatch = useCallback(async (entry, confirmFirstContact) => {
    setSending(true);
    const [sent, err] = await sendOutboxEntry(entry.id, { confirmFirstContact }, { silent: true })
      .then((value) => [value, null])
      .catch((sendError) => [null, sendError]);
    if (!mountedRef.current) return false;
    setSending(false);

    if (err?.code === 'FIRST_CONTACT_CONFIRMATION_REQUIRED') {
      // Not an error state: a question. The composer renders it inline.
      setConfirmation({ entry, message: err.message });
      return false;
    }
    setConfirmation(null);
    if (err) {
      setError(err.message || 'Could not send the message');
      toast.error(err.message || 'Could not send the message');
      await refresh();
      return false;
    }
    setError(null);
    setEntries((prev) => [sent, ...prev.filter((row) => row.id !== sent.id)]);
    onSentRef.current?.();
    return true;
  }, [refresh]);

  // `sending` is React state, so it only reflects a send that has already
  // re-rendered. Two `submit()` calls inside ONE render — a double-fired Send
  // button, an Enter keydown racing the click — both read it as false, both
  // create a durable row, and both dispatch a real message. Beeper has no
  // idempotency key, so that second message is unrecallable. This ref latches
  // synchronously, before the first await, and is the actual guard; `sending`
  // stays as the RENDER signal it already is.
  const submittingRef = useRef(false);

  /** Step one + step two, from the composer's Send action. */
  const submit = useCallback(async (body) => {
    const text = typeof body === 'string' ? body.trim() : '';
    if (!conversationId || !text || sending || submittingRef.current) return false;
    submittingRef.current = true;
    try {
      setError(null);
      const [entry, err] = await createOutboxEntry(conversationId, text, { silent: true })
        .then((value) => [value, null])
        .catch((createError) => [null, createError]);
      if (!mountedRef.current) return false;
      if (err) {
        setError(err.message || 'Could not queue the message');
        toast.error(err.message || 'Could not queue the message');
        return false;
      }
      setEntries((prev) => [entry, ...prev]);
      // Awaited into a local rather than returned bare: `return dispatch(...)`
      // would run the `finally` and drop the latch before the send resolved.
      const dispatched = await dispatch(entry, false);
      return dispatched;
    } finally {
      // `finally`, not a catch: nothing is swallowed, but the latch must not
      // survive a throw or the composer is wedged shut for the session.
      submittingRef.current = false;
    }
  }, [conversationId, dispatch, sending]);

  /** The inline confirmation's "Send" — the same row, now explicitly confirmed. */
  const confirmAndSend = useCallback(async () => {
    if (!confirmation?.entry) return false;
    return dispatch(confirmation.entry, true);
  }, [confirmation, dispatch]);

  /**
   * The inline confirmation's "Cancel". The row stays `approved` and visible
   * rather than being deleted: it is a record of an intent the user paused on,
   * and re-sending it is a deliberate act, not a leftover.
   */
  const cancelConfirmation = useCallback(() => setConfirmation(null), []);

  return {
    entries,
    sending,
    error,
    confirmation,
    submit,
    confirmAndSend,
    cancelConfirmation,
    refresh,
  };
}

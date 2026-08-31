import { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import type { ChatMessageView, ChatRetentionNotice, SessionView } from '@astro/contracts';

import { useAuth } from '../auth/AuthProvider';
import { getSessionMessages } from '../lib/chat-api';
import { getSession } from '../lib/sessions-api';
import { sortMessagesOldestFirst } from '../call/useChatPane';
import {
  counterpartName,
  formatBilledDuration,
  formatSessionDate,
  sessionOutcomeLabel,
} from '../lib/session-display';
import { ApiError } from '../types/api';

/**
 * A finished text consultation, read back.
 *
 * Deliberately HTTP and not the `/chat` socket: opening a socket to read a conversation that
 * ended last week would join a room nobody is in. The socket's join ack is the right shape for
 * a live pane; this is the other case, and `GET /sessions/:id/messages` exists for it.
 */
export function TranscriptPage() {
  const { id } = useParams<{ id: string }>();
  const { me } = useAuth();

  const [session, setSession] = useState<SessionView | null>(null);
  const [messages, setMessages] = useState<ChatMessageView[]>([]);
  const [retention, setRetention] = useState<ChatRetentionNotice | null>(null);
  const [purgedAt, setPurgedAt] = useState<string | null>(null);
  const [messageCount, setMessageCount] = useState(0);
  const [olderCursor, setOlderCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!id) return;
    const sessionId = id;
    let cancelled = false;

    setLoading(true);
    setError(null);

    void (async () => {
      try {
        // Both in parallel: the header needs the session, the body needs the page, and neither
        // depends on the other.
        const [detail, page] = await Promise.all([
          getSession(sessionId),
          getSessionMessages(sessionId),
        ]);
        if (cancelled) return;

        setSession(detail);
        setMessages(sortMessagesOldestFirst(page.messages));
        setRetention(page.retention);
        setPurgedAt(page.purgedAt);
        setMessageCount(page.messageCount);
        setOlderCursor(page.nextCursor);
      } catch (err) {
        if (cancelled) return;
        setError(
          err instanceof ApiError ? err.message : 'Could not load this consultation',
        );
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [id]);

  const loadOlder = useCallback(async () => {
    if (!id || !olderCursor) return;
    setLoadingOlder(true);
    try {
      const page = await getSessionMessages(id, { before: olderCursor });
      // History pages come newest-first and prepend; the merged list is re-sorted rather than
      // concatenated, so a page boundary cannot leave two messages out of order.
      setMessages((prev) => sortMessagesOldestFirst([...page.messages, ...prev]));
      setOlderCursor(page.nextCursor);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not load older messages');
    } finally {
      setLoadingOlder(false);
    }
  }, [id, olderCursor]);

  if (loading) return <p className="muted center">Loading…</p>;

  if (error || !session) {
    return (
      <div className="narrow-page">
        <p className="error-banner">{error ?? 'Not found'}</p>
        <Link to="/history" className="btn secondary">
          Back to consultations
        </Link>
      </div>
    );
  }

  const duration = formatBilledDuration(session.billedSeconds);

  return (
    <div className="transcript-page">
      <Link to="/history" className="back-link">
        ← All consultations
      </Link>

      <header className="transcript-header">
        <div>
          <p className="eyebrow">Text consultation</p>
          <h1>{counterpartName(session, me?.id)}</h1>
          <p className="muted">{formatSessionDate(session.createdAt)}</p>
        </div>
        <div className="transcript-stats">
          <span>{sessionOutcomeLabel(session)}</span>
          {duration && <span>{duration}</span>}
          <span>
            {messageCount} message{messageCount === 1 ? '' : 's'}
          </span>
        </div>
      </header>

      {/*
        The three states below are genuinely different and must not be collapsed. A purged
        transcript renders the same empty array as a conversation nobody spoke in, and a UI
        that cannot tell them apart shows a blank pane for a consultation that definitely
        happened. `transcriptPurgedAt` is the field that exists to separate them.
      */}
      {purgedAt ? (
        <div className="transcript-empty">
          <p className="status-banner">
            This transcript was deleted on {new Date(purgedAt).toLocaleDateString()} under the
            retention policy.
          </p>
          <p className="muted">
            {messageCount} message{messageCount === 1 ? '' : 's'} were exchanged. The text itself
            is gone; the record that this consultation happened is not.
          </p>
        </div>
      ) : messages.length === 0 ? (
        <p className="muted center">Nothing was said in this consultation.</p>
      ) : (
        <>
          {olderCursor && (
            <div className="load-more">
              <button
                type="button"
                className="btn ghost"
                disabled={loadingOlder}
                onClick={() => void loadOlder()}
              >
                {loadingOlder ? 'Loading…' : 'Load older messages'}
              </button>
            </div>
          )}

          <div className="chat-messages transcript-messages">
            {messages.map((msg) => {
              const mine = msg.senderUserId === me?.id;
              return (
                <div key={msg.id} className={`chat-bubble-row${mine ? ' mine' : ''}`}>
                  <div className={`chat-bubble${mine ? ' mine' : ''}`}>
                    {msg.body}
                    <span className="chat-bubble-time">
                      {new Date(msg.createdAt).toLocaleTimeString(undefined, {
                        hour: 'numeric',
                        minute: '2-digit',
                      })}
                    </span>
                  </div>
                </div>
              );
            })}
          </div>
        </>
      )}

      {/* Said up front, not discovered later: a transcript that vanishes between two visits
          with no warning is indistinguishable from data loss. */}
      {!purgedAt && retention?.deleteAfter && (
        <p className="hint transcript-retention">
          This transcript is deleted after{' '}
          {new Date(retention.deleteAfter).toLocaleDateString()} ({retention.retentionDays} days
          after the consultation ended).
        </p>
      )}
    </div>
  );
}

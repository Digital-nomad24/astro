import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import type { SessionView } from '@astro/contracts';

import { useAuth } from '../auth/AuthProvider';
import { isMentorRole } from '../lib/roles';
import { formatRatePerMinute } from '../lib/money';
import { listSessions } from '../lib/sessions-api';
import {
  counterpartName,
  formatBilledDuration,
  formatSessionDate,
  sessionOutcomeLabel,
  transcriptStatus,
} from '../lib/session-display';
import { ApiError } from '../types/api';

type Side = 'user' | 'mentor';

export function HistoryPage() {
  const { me } = useAuth();
  const canSwitchSide = isMentorRole(me?.role);

  // A mentor lands on the side they actually work on. A plain user has only one side, and the
  // toggle is hidden rather than disabled — `as=mentor` 404s without a mentor profile.
  const [side, setSide] = useState<Side>(canSwitchSide ? 'mentor' : 'user');
  const [sessions, setSessions] = useState<SessionView[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);

    void (async () => {
      try {
        const page = await listSessions({ as: side });
        if (cancelled) return;
        setSessions(page.items);
        setNextCursor(page.nextCursor);
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof ApiError ? err.message : 'Could not load your consultations');
        setSessions([]);
        setNextCursor(null);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [side]);

  const loadMore = useCallback(async () => {
    if (!nextCursor) return;
    setLoadingMore(true);
    try {
      const page = await listSessions({ as: side, cursor: nextCursor });
      // Append rather than replace: keyset paging means the cursor already excludes what we
      // have, so there is nothing to de-duplicate.
      setSessions((prev) => [...prev, ...page.items]);
      setNextCursor(page.nextCursor);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not load more');
    } finally {
      setLoadingMore(false);
    }
  }, [nextCursor, side]);

  return (
    <div className="history-page">
      <header className="history-header">
        <div>
          <h1>Consultations</h1>
          <p className="lead">
            {side === 'mentor'
              ? 'People you have advised.'
              : 'Mentors you have consulted.'}
          </p>
        </div>
        {canSwitchSide && (
          <div className="side-toggle" role="tablist" aria-label="Which side to show">
            <button
              type="button"
              role="tab"
              aria-selected={side === 'mentor'}
              className={`btn ghost${side === 'mentor' ? ' active' : ''}`}
              onClick={() => setSide('mentor')}
            >
              As mentor
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={side === 'user'}
              className={`btn ghost${side === 'user' ? ' active' : ''}`}
              onClick={() => setSide('user')}
            >
              As me
            </button>
          </div>
        )}
      </header>

      {error && <p className="error-banner">{error}</p>}

      {loading ? (
        <p className="muted center">Loading…</p>
      ) : sessions.length === 0 ? (
        <p className="muted center">
          {side === 'mentor'
            ? 'Nobody has consulted you yet.'
            : 'You have not consulted anyone yet.'}
        </p>
      ) : (
        <ul className="history-list">
          {sessions.map((session) => (
            <HistoryRow key={session.id} session={session} meId={me?.id} />
          ))}
        </ul>
      )}

      {nextCursor && (
        <div className="load-more">
          <button
            type="button"
            className="btn secondary"
            disabled={loadingMore}
            onClick={() => void loadMore()}
          >
            {loadingMore ? 'Loading…' : 'Load older'}
          </button>
        </div>
      )}
    </div>
  );
}

function HistoryRow({ session, meId }: { session: SessionView; meId: string | undefined }) {
  const duration = formatBilledDuration(session.billedSeconds);
  const transcript = transcriptStatus(session);

  return (
    <li className="history-row">
      <div className="history-row-main">
        <span className={`mode-tag ${session.mode.toLowerCase()}`}>
          {session.mode === 'TEXT' ? 'Chat' : 'Voice'}
        </span>
        <div className="history-row-who">
          <strong>{counterpartName(session, meId)}</strong>
          <span className="muted">{formatSessionDate(session.createdAt)}</span>
        </div>
      </div>

      <div className="history-row-meta">
        <span className="history-outcome">{sessionOutcomeLabel(session)}</span>
        {/* No duration means the two sides never actually connected — a declined call has
            nothing to show, and "0:00" would read as a consultation that lasted no time. */}
        {duration && <span className="history-duration">{duration}</span>}
        <span className="muted">{formatRatePerMinute(session.ratePaisePerMinute)}</span>
        {session.rating != null && <span className="history-rating">★ {session.rating}</span>}
      </div>

      <div className="history-row-actions">
        {transcript?.kind === 'readable' && (
          <Link to={`/history/${session.id}`} className="btn ghost">
            {transcript.label}
          </Link>
        )}
        {transcript?.kind === 'purged' && <span className="hint">{transcript.label}</span>}
      </div>
    </li>
  );
}

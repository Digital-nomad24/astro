import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import type { MentorPresenceSnapshot } from '@astro/contracts/sockets';

import { PresenceBadge } from '../components/PresenceBadge';
import { useCall } from '../call/CallProvider';
import { apiGet } from '../lib/api';
import { formatRatePerMinute } from '../lib/money';
import { connectPresence, onPresenceChanged, subscribePresence } from '../lib/socket';
import type { MentorDetailResponse } from '../types/api';

export function MentorDetailPage() {
  const { id } = useParams<{ id: string }>();
  const [mentor, setMentor] = useState<MentorDetailResponse | null>(null);
  const [presence, setPresence] = useState<MentorPresenceSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const { startVoiceCall, startTextChat, busy: callBusy, phase: callPhase } = useCall();

  useEffect(() => {
    if (!id) return;
    const mentorId = id;
    let cancelled = false;
    let unsub: (() => void) | undefined;

    async function load() {
      setLoading(true);
      setError(null);
      try {
        const detail = await apiGet<MentorDetailResponse>(`/mentors/${mentorId}`);
        if (cancelled) return;
        setMentor(detail);

        await connectPresence();
        const snapshot = await subscribePresence({ mentorProfileIds: [mentorId] });
        if (cancelled) return;
        if (snapshot[0]) setPresence(snapshot[0]);

        unsub = onPresenceChanged((s) => {
          if (s.mentorProfileId === mentorId) {
            setPresence((prev) => (!prev || s.updatedAtMs >= prev.updatedAtMs ? s : prev));
          }
        });
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Mentor not found');
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    void load();
    return () => {
      cancelled = true;
      unsub?.();
    };
  }, [id]);

  if (loading) {
    return <p className="muted center">Loading…</p>;
  }

  if (error || !mentor) {
    return (
      <div className="narrow-page">
        <p className="error-banner">{error ?? 'Not found'}</p>
        <Link to="/browse" className="btn secondary">
          Back to browse
        </Link>
      </div>
    );
  }

  const liveState = presence?.state ?? mentor.presenceState;
  const liveAccepting = presence?.acceptingNewCalls ?? mentor.acceptingNewCalls;
  const liveQueue = presence?.queueDepth ?? mentor.queueDepth;

  // Mirrors what the server actually rejects: offline, or not taking new sessions. **BUSY is
  // bookable** — that is what the queue is for, and disabling the button for it made every
  // busy mentor unreachable. Anyone already waiting also means a queue, even for an idle
  // mentor, because the server will not ring a newcomer past people who have been waiting.
  const wouldQueue = liveState === 'BUSY' || liveQueue > 0;
  const cannotStart = liveState === 'OFFLINE' || !liveAccepting;
  const ctaDisabled = callBusy || callPhase !== 'idle' || cannotStart;

  return (
    <div className="detail-page">
      <Link to="/browse" className="back-link">
        ← All mentors
      </Link>
      <header className="detail-header">
        <div>
          <p className="eyebrow">{mentor.categoryName}</p>
          <h1>{mentor.displayName}</h1>
          {mentor.headline && <p className="lead">{mentor.headline}</p>}
        </div>
        <PresenceBadge state={liveState} accepting={liveAccepting} />
      </header>

      <div className="detail-stats">
        <div>
          <span className="stat-label">Rate</span>
          <span className="stat-value">{formatRatePerMinute(mentor.ratePaisePerMinute)}</span>
        </div>
        <div>
          <span className="stat-label">Rating</span>
          <span className="stat-value">
            ★ {mentor.ratingAvg.toFixed(1)} ({mentor.ratingCount})
          </span>
        </div>
        <div>
          <span className="stat-label">Experience</span>
          <span className="stat-value">{mentor.experienceYears} years</span>
        </div>
        <div>
          <span className="stat-label">Sessions</span>
          <span className="stat-value">{mentor.totalSessions}</span>
        </div>
        {liveQueue > 0 && (
          <div>
            <span className="stat-label">Queue</span>
            <span className="stat-value">{liveQueue} waiting</span>
          </div>
        )}
      </div>

      {mentor.bio && (
        <section className="detail-section">
          <h2>About</h2>
          <p>{mentor.bio}</p>
        </section>
      )}

      <section className="detail-section">
        <h2>Languages</h2>
        <div className="tag-row">
          {mentor.languages.map((lang) => (
            <span key={lang} className="tag">
              {lang}
            </span>
          ))}
        </div>
      </section>

      <div className="cta-row">
        <button
          type="button"
          className="btn primary"
          disabled={ctaDisabled}
          onClick={() => {
            if (!id) return;
            void startVoiceCall(id);
          }}
        >
          {callBusy
            ? 'Starting…'
            : wouldQueue
              ? 'Join queue for a voice call'
              : 'Start voice consultation'}
        </button>
        <button
          type="button"
          className="btn secondary"
          disabled={ctaDisabled}
          onClick={() => {
            if (!id) return;
            void startTextChat(id);
          }}
        >
          {callBusy ? 'Starting…' : wouldQueue ? 'Join queue for a text chat' : 'Start text chat'}
        </button>
        {liveState === 'OFFLINE' && (
          <p className="hint">Mentor must be online to start a session.</p>
        )}
        {liveState !== 'OFFLINE' && !liveAccepting && (
          <p className="hint">Mentor is not accepting new sessions right now.</p>
        )}
        {!cannotStart && wouldQueue && (
          <p className="hint">
            {liveQueue > 0
              ? `${liveQueue} ${liveQueue === 1 ? 'person is' : 'people are'} waiting. You'll be
                 held in line and connected when it's your turn — nothing is charged while you wait.`
              : `They're on another session. You'll be held in line and connected when it ends —
                 nothing is charged while you wait.`}
          </p>
        )}
        {!cannotStart && callPhase === 'queued' && (
          <p className="hint">You're already waiting in a queue.</p>
        )}
      </div>
    </div>
  );
}

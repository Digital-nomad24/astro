import { useEffect, useState } from 'react';

import { useAuth } from '../auth/AuthProvider';
import { useCall, type QueueExitReason } from '../call/CallProvider';
import { usePushToTalk } from '../call/usePushToTalk';
import { useVoiceRoom } from '../call/useVoiceRoom';
import { counterpartName } from '../lib/session-display';
import { ChatPane } from './ChatPane';

function formatCountdown(ms: number): string {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${s}s`;
}

/** Coarse on purpose: a queue estimate that ticks by the second reads as a promise. */
function formatDuration(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return 'under a minute';
  const m = Math.round(s / 60);
  if (m < 60) return `~${m} min`;
  const h = Math.floor(m / 60);
  const rest = m % 60;
  return rest === 0 ? `~${h} hr` : `~${h} hr ${rest} min`;
}

function ordinal(n: number): string {
  const mod100 = n % 100;
  if (mod100 >= 11 && mod100 <= 13) return `${n}th`;
  switch (n % 10) {
    case 1:
      return `${n}st`;
    case 2:
      return `${n}nd`;
    case 3:
      return `${n}rd`;
    default:
      return `${n}th`;
  }
}

/**
 * `queueExit` refines the ending rather than replacing it: the server files every abandoned
 * wait as `QUEUE_EXPIRED`, which cannot tell a half-hour wait from a phone that lost signal.
 */
function endReasonLabel(
  reason: string | null,
  isText: boolean,
  queueExit: QueueExitReason | null,
): string {
  const noun = isText ? 'Chat' : 'Call';
  switch (reason) {
    case 'COMPLETED_BY_USER':
    case 'COMPLETED_BY_MENTOR':
      return `${noun} ended`;
    case 'DECLINED':
      return `${noun} declined`;
    case 'CANCELLED_BY_USER':
      return queueExit === 'CANCELLED_BY_USER' ? 'You left the queue' : `${noun} cancelled`;
    case 'RING_TIMEOUT':
      return 'No answer';
    case 'MEDIA_FAILURE':
      return 'Connection failed';
    case 'MENTOR_OFFLINE':
      return 'Mentor went offline';
    case 'IDLE_TIMEOUT':
      return 'Chat ended due to inactivity';
    case 'QUEUE_EXPIRED':
      if (queueExit === 'DISCONNECTED') return 'You were offline too long';
      if (queueExit === 'CANCELLED_BY_USER') return 'You left the queue';
      return 'Your turn never came';
    case 'BALANCE_EXHAUSTED':
      return 'Wallet balance ran out';
    case 'MAX_DURATION_REACHED':
      return `${noun} reached its time limit`;
    case 'ADMIN_TERMINATED':
      return `${noun} ended by support`;
    default:
      return `${noun} ended`;
  }
}

/** The explanatory line under the heading, where one helps. */
function endReasonDetail(reason: string | null, queueExit: QueueExitReason | null): string | null {
  if (reason === 'QUEUE_EXPIRED') {
    if (queueExit === 'DISCONNECTED') {
      return 'We held your place for a while after your connection dropped, then released it.';
    }
    if (queueExit === 'TTL_EXPIRED') {
      return 'You waited the maximum time without reaching the front. Nothing was charged.';
    }
    return 'Nothing was charged.';
  }
  if (reason === 'MENTOR_OFFLINE') {
    return 'They went offline while you were waiting, so the queue was released.';
  }
  return null;
}

function sessionTitle(
  session: { userId: string; mentorDisplayName: string },
  meId: string | undefined,
): string {
  if (!meId) return session.mentorDisplayName;
  return session.userId === meId ? session.mentorDisplayName : 'Consultation';
}

export function CallOverlay() {
  const { me } = useAuth();
  const {
    phase,
    session,
    credentials,
    queue,
    queueExitReason,
    ringExpiresAtMs,
    endReason,
    error,
    busy,
    acceptCall,
    declineCall,
    cancelCall,
    leaveQueue,
    hangUp,
    dismissEnded,
    clearError,
  } = useCall();

  const isText = session?.mode === 'TEXT';
  const isVoice = session?.mode === 'VOICE';

  const shouldConnectAudio =
    isVoice &&
    credentials != null &&
    (phase === 'outgoing' || phase === 'active');
  const { connected: audioConnected, error: audioError, setTransmitting, remoteMicMuted } =
    useVoiceRoom(credentials, shouldConnectAudio);
  const ptt = usePushToTalk({
    active: isVoice && phase === 'active',
    setTransmitting,
  });

  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (phase !== 'incoming' && phase !== 'outgoing' && phase !== 'queued') return;
    const id = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(id);
  }, [phase]);

  if (phase === 'idle' && !error) return null;

  const ringRemaining =
    ringExpiresAtMs != null ? formatCountdown(ringExpiresAtMs - now) : null;

  // How long the server will hold this place before the sweeper releases it.
  const holdRemaining =
    queue != null
      ? formatDuration((new Date(queue.expiresAt).getTime() - now) / 1000)
      : null;

  const dialogLabel =
    phase === 'queued' ? 'Waiting in queue' : isText ? 'Text consultation' : 'Voice call';
  const panelClass = isText && phase === 'active' ? 'call-panel chat-panel' : 'call-panel';

  return (
    <div className="call-overlay" role="dialog" aria-modal="true" aria-label={dialogLabel}>
      <div className={panelClass}>
        {(error || (isVoice && audioError)) && (
          <p className="error-banner">
            {error ?? audioError}
            <button type="button" className="link-btn" onClick={clearError}>
              Dismiss
            </button>
          </p>
        )}

        {/*
          `session.userId === me.id` is redundant with the provider's `shouldAdopt`, and kept
          anyway: a mentor is a participant of every session queued against them, so this panel
          is one bad state away from telling a mentor they are waiting for themselves.
        */}
        {phase === 'queued' && session && session.userId === me?.id && (
          <>
            <p className="eyebrow">{isText ? 'Text chat' : 'Voice call'} · waiting</p>
            <h2>
              {queue?.position === 1
                ? `You're next for ${session.mentorDisplayName}`
                : `You're in line for ${session.mentorDisplayName}`}
            </h2>

            {queue ? (
              <>
                <div className="queue-place">
                  <span className="queue-position">{ordinal(queue.position)}</span>
                  <span className="queue-of">of {queue.queueDepth} waiting</span>
                </div>
                <p className="muted">
                  {queue.position === 1
                    ? `They're on another ${isText ? 'chat' : 'call'} — you'll be connected as soon as it ends.`
                    : `Estimated wait ${formatDuration(queue.etaSeconds)}.`}
                </p>
                <p className="hint">
                  Keep this tab open. We hold your place for {holdRemaining}, and for a short
                  while if you lose connection.
                </p>
              </>
            ) : (
              <p className="muted">Getting your place in line…</p>
            )}

            <div className="call-actions">
              <button
                type="button"
                className="btn secondary"
                disabled={busy}
                onClick={() => void leaveQueue()}
              >
                Leave queue
              </button>
            </div>
          </>
        )}

        {phase === 'outgoing' && session && isVoice && (
          <>
            <p className="eyebrow">Voice call</p>
            <h2>Calling {session.mentorDisplayName}…</h2>
            {ringRemaining && <p className="muted">Ring timeout in {ringRemaining}</p>}
            <p className="muted">
              {audioConnected ? 'Connected — waiting for answer' : 'Connecting audio…'}
            </p>
            <button
              type="button"
              className="btn secondary"
              disabled={busy}
              onClick={() => void cancelCall()}
            >
              Cancel
            </button>
          </>
        )}

        {phase === 'outgoing' && session && isText && (
          <>
            <p className="eyebrow">Text chat</p>
            <h2>Requesting chat with {session.mentorDisplayName}…</h2>
            {ringRemaining && <p className="muted">Ring timeout in {ringRemaining}</p>}
            <p className="muted">Waiting for the mentor to accept.</p>
            <button
              type="button"
              className="btn secondary"
              disabled={busy}
              onClick={() => void cancelCall()}
            >
              Cancel
            </button>
          </>
        )}

        {phase === 'incoming' && session && (
          <>
            <p className="eyebrow">{isText ? 'Incoming text chat' : 'Incoming call'}</p>
            <h2>{session.userDisplayName ?? 'Someone'} wants to consult</h2>
            {ringRemaining && <p className="muted">Answer within {ringRemaining}</p>}
            <div className="call-actions">
              <button
                type="button"
                className="btn primary"
                disabled={busy}
                onClick={() => void acceptCall()}
              >
                Accept
              </button>
              <button
                type="button"
                className="btn ghost"
                disabled={busy}
                onClick={() => void declineCall()}
              >
                Decline
              </button>
            </div>
          </>
        )}

        {phase === 'active' && session && isVoice && (
          <>
            <p className="eyebrow">In session</p>
            <h2>{sessionTitle(session, me?.id)}</h2>
            <p className="ptt-status muted">
              {!audioConnected
                ? 'Connecting audio…'
                : ptt.enabled && ptt.held
                  ? 'Transmitting…'
                  : ptt.enabled
                    ? 'Mic muted — hold to talk'
                    : 'Mic live'}
            </p>
            {remoteMicMuted === true && (
              <p className="ptt-status muted">
                {counterpartName(session, me?.id)} is muted
              </p>
            )}
            {ptt.enabled && (
              <>
                <button
                  type="button"
                  className={`btn ptt-hold${ptt.held ? ' active' : ''}`}
                  aria-pressed={ptt.held}
                  {...ptt.holdHandlers}
                >
                  {ptt.held ? 'Transmitting…' : 'Hold to talk'}
                </button>
                <p className="hint">Hold Space or this button</p>
              </>
            )}
            <div className="call-actions">
              <button
                type="button"
                className="btn ghost"
                onClick={() => ptt.setEnabled(!ptt.enabled)}
              >
                Push to talk: {ptt.enabled ? 'On' : 'Off'}
              </button>
              <button
                type="button"
                className="btn primary"
                disabled={busy}
                onClick={() => void hangUp()}
              >
                End call
              </button>
            </div>
          </>
        )}

        {phase === 'active' && session && isText && (
          <ChatPane
            sessionId={session.id}
            title={sessionTitle(session, me?.id)}
            billingAnchorAt={session.billingAnchorAt}
            onEnd={() => void hangUp()}
            endBusy={busy}
          />
        )}

        {phase === 'ended' && (
          <>
            <p className="eyebrow">
              {queueExitReason ? 'Queue' : isText ? 'Chat finished' : 'Call finished'}
            </p>
            <h2>{endReasonLabel(endReason, isText, queueExitReason)}</h2>
            {endReasonDetail(endReason, queueExitReason) && (
              <p className="muted">{endReasonDetail(endReason, queueExitReason)}</p>
            )}
            <button type="button" className="btn secondary" onClick={dismissEnded}>
              Close
            </button>
          </>
        )}
      </div>
    </div>
  );
}

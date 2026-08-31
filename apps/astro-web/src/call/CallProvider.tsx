import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import type {
  CallJoinCredentials,
  QueueLeaveReason,
  QueuePositionView,
  SessionEndReason,
  SessionStatus,
  SessionView,
} from '@astro/contracts';

const TERMINAL_STATUSES: SessionStatus[] = ['COMPLETED', 'CANCELLED', 'FAILED'];

function isTerminal(status: SessionStatus): boolean {
  return TERMINAL_STATUSES.includes(status);
}

import { useAuth } from '../auth/AuthProvider';
import {
  bindCallsHandlers,
  callsResync,
  connectCalls,
  disconnectCalls,
} from '../lib/calls-socket';
import {
  acceptSession,
  cancelSession,
  declineSession,
  endSession,
  refreshCredentials,
  startSession,
} from '../lib/sessions-api';
import { ApiError } from '../types/api';

export type CallPhase = 'idle' | 'queued' | 'outgoing' | 'incoming' | 'active' | 'ended';

/** Why the wait ended without a call. More precise than the `SessionEndReason` that follows it. */
export type QueueExitReason = Exclude<QueueLeaveReason, 'PROMOTED'>;

interface CallContextValue {
  phase: CallPhase;
  session: SessionView | null;
  credentials: CallJoinCredentials | null;
  /** Our place in line. Non-null exactly while `phase === 'queued'`. */
  queue: QueuePositionView | null;
  queueExitReason: QueueExitReason | null;
  ringExpiresAtMs: number | null;
  endReason: SessionEndReason | null;
  error: string | null;
  busy: boolean;
  startVoiceCall: (mentorProfileId: string) => Promise<void>;
  startTextChat: (mentorProfileId: string) => Promise<void>;
  acceptCall: () => Promise<void>;
  declineCall: () => Promise<void>;
  cancelCall: () => Promise<void>;
  leaveQueue: () => Promise<void>;
  hangUp: () => Promise<void>;
  dismissEnded: () => void;
  clearError: () => void;
}

const CallContext = createContext<CallContextValue | null>(null);

function phaseForSession(
  session: SessionView,
  userId: string,
): CallPhase {
  if (isTerminal(session.status)) return 'ended';
  if (session.status === 'ACTIVE') return 'active';
  if (session.status === 'RINGING') {
    return session.userId === userId ? 'outgoing' : 'incoming';
  }
  // A QUEUED session is the caller's alone. The mentor is a participant of it and therefore
  // receives its `calls:state`, but they are not waiting for anything — they are the thing
  // being waited for.
  if (session.status === 'QUEUED') return session.userId === userId ? 'queued' : 'idle';
  return 'idle';
}

/**
 * Whether a pushed session should become the one this client is showing.
 *
 * `calls:state` goes to **both** participants of a session, and a mentor is a participant of
 * every session queued against them. Without this filter, someone joining a busy mentor's
 * queue overwrites the call that mentor is currently on — flipping their phase, tearing down
 * their LiveKit room through `useVoiceRoom`'s `enabled`, and replacing their call UI with a
 * queue panel for a session they cannot act on.
 */
function shouldAdopt(
  next: SessionView,
  userId: string,
  current: SessionView | null,
): boolean {
  // Updates to the session we are already showing are always ours to apply.
  if (current && next.id === current.id) return true;
  // Anything else must not displace a session still in progress.
  if (current && !isTerminal(current.status)) return false;
  // Idle: adopt only what this client can actually act on. A queue place belongs to its caller.
  if (next.status === 'QUEUED') return next.userId === userId;
  return !isTerminal(next.status);
}

export function CallProvider({ children }: { children: ReactNode }) {
  const { me, isOnboarded, firebaseUser } = useAuth();
  const [phase, setPhase] = useState<CallPhase>('idle');
  const [session, setSession] = useState<SessionView | null>(null);
  const [credentials, setCredentials] = useState<CallJoinCredentials | null>(null);
  const [queue, setQueue] = useState<QueuePositionView | null>(null);
  const [queueExitReason, setQueueExitReason] = useState<QueueExitReason | null>(null);
  const [ringExpiresAtMs, setRingExpiresAtMs] = useState<number | null>(null);
  const [endReason, setEndReason] = useState<SessionEndReason | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Socket handlers are bound once per identity; these keep them off stale closures.
  const sessionRef = useRef<SessionView | null>(null);
  const credentialsRef = useRef<CallJoinCredentials | null>(null);
  /** Session id whose credentials are being fetched, so back-to-back states mint one token. */
  const credentialsFetchRef = useRef<string | null>(null);
  sessionRef.current = session;
  credentialsRef.current = credentials;

  const applySession = useCallback(
    (
      next: SessionView,
      creds: CallJoinCredentials | null,
      opts: { ringMs?: number; queue?: QueuePositionView | null } = {},
    ) => {
      // Eagerly, not just on the next render: socket events can arrive several to a tick, and
      // the guards in those handlers compare against this ref.
      sessionRef.current = next;
      setSession(next);
      setCredentials(creds);
      if (opts.ringMs != null) setRingExpiresAtMs(opts.ringMs);
      if (opts.queue !== undefined) setQueue(opts.queue);
      if (!me) return;
      setPhase(phaseForSession(next, me.id));
    },
    [me],
  );

  const resetCall = useCallback(() => {
    credentialsFetchRef.current = null;
    sessionRef.current = null;
    setPhase('idle');
    setSession(null);
    setCredentials(null);
    setQueue(null);
    setQueueExitReason(null);
    setRingExpiresAtMs(null);
    setEndReason(null);
  }, []);

  useEffect(() => {
    if (!firebaseUser || !isOnboarded || !me) {
      disconnectCalls();
      resetCall();
      return;
    }

    let unbind: (() => void) | undefined;

    void (async () => {
      try {
        await connectCalls();
        unbind = bindCallsHandlers({
          onIncoming: ({ session: s, ringExpiresAtMs: ringMs }) => {
            if (s.mentorUserId !== me.id) return;
            applySession(s, null, { ringMs });
          },
          onState: ({ session: s }) => {
            if (!shouldAdopt(s, me.id, sessionRef.current)) return;
            sessionRef.current = s;
            setSession(s);
            setPhase(phaseForSession(s, me.id));
            // Left the queue — either promoted or ended. Either way the position is stale.
            if (s.status !== 'QUEUED') setQueue(null);

            // **Promotion is where a queued voice call gets its room.** No LiveKit room exists
            // while a session is QUEUED — holding one open for a half-hour wait would be a
            // billable resource nobody is in — so the caller has no credentials until now, and
            // without fetching them here they would sit in a ringing call with no audio.
            if (
              s.mode === 'VOICE' &&
              s.status === 'RINGING' &&
              s.userId === me.id &&
              !credentialsRef.current &&
              credentialsFetchRef.current !== s.id
            ) {
              credentialsFetchRef.current = s.id;
              void refreshCredentials(s.id)
                .then((result) => {
                  // Discard if the session moved on while the request was in flight.
                  if (sessionRef.current?.id !== s.id) return;
                  setCredentials(result.credentials);
                })
                .catch(() => {
                  credentialsFetchRef.current = null;
                  setError(
                    'Could not connect audio for this call. Try cancelling and calling again.',
                  );
                });
            }
          },
          onConnected: ({ sessionId, billingAnchorAt }) => {
            if (sessionRef.current?.id !== sessionId) return;
            setPhase('active');
            setSession((prev) =>
              prev ? { ...prev, billingAnchorAt } : prev,
            );
          },
          onEnded: ({ sessionId, endReason: reason }) => {
            // **Must match the session we are showing.** A mentor is a participant of every
            // session queued against them, so a waiting user cancelling or timing out sends
            // this mentor a `calls:ended` — and acting on it would end the call they are
            // actually on, audio and all.
            if (sessionRef.current?.id !== sessionId) return;
            setEndReason(reason as SessionEndReason);
            setPhase('ended');
            setCredentials(null);
            setQueue(null);
          },
          onQueuePosition: (position) => {
            // Addressed to this user, and a user may wait in only one queue at a time — but a
            // push can still land just after we left, so match the session before trusting it.
            if (sessionRef.current?.id !== position.sessionId) return;
            setQueue(position);
          },
          onQueueLeft: ({ sessionId, reason }) => {
            if (sessionRef.current?.id !== sessionId) return;
            // Only the copy. The `calls:ended` that follows drives the phase, but its
            // `QUEUE_EXPIRED` cannot tell a 30-minute wait from a dropped connection.
            setQueueExitReason(reason);
            setQueue(null);
          },
        });

        const resync = await callsResync();
        if (resync.session) {
          applySession(resync.session, resync.credentials, { queue: resync.queue });
        }
      } catch {
        /* calls socket is best-effort until user starts a call */
      }
    })();

    return () => {
      unbind?.();
    };
  }, [firebaseUser, isOnboarded, me, applySession, resetCall]);

  /**
   * Both entry points behave identically: the response comes back either ringing or queued,
   * and `result.queue` is the one field that says which.
   */
  const beginSession = useCallback(
    async (mentorProfileId: string, mode: 'VOICE' | 'TEXT') => {
      setBusy(true);
      setError(null);
      // A previous wait that expired must not colour this attempt.
      setEndReason(null);
      setQueueExitReason(null);
      try {
        const result = await startSession(mentorProfileId, mode);
        applySession(result.session, result.credentials, { queue: result.queue });
      } catch (err) {
        const fallback = mode === 'TEXT' ? 'Could not start chat' : 'Could not start call';
        setError(err instanceof ApiError ? err.message : fallback);
      } finally {
        setBusy(false);
      }
    },
    [applySession],
  );

  const startVoiceCall = useCallback(
    (mentorProfileId: string) => beginSession(mentorProfileId, 'VOICE'),
    [beginSession],
  );

  const startTextChat = useCallback(
    (mentorProfileId: string) => beginSession(mentorProfileId, 'TEXT'),
    [beginSession],
  );

  /**
   * Applies the response of a terminal action — end, decline, cancel — **unless the socket has
   * already moved this client on to a different session.**
   *
   * `POST /sessions/:id/end` runs the whole of `settle()` before it writes its response, and
   * `settle()` dispatches the mentor's queue on the way out. So by the time this promise
   * resolves, `calls:ended` *and* the promoted caller's `calls:incoming` have both already been
   * handled. Applying the response blindly replaces the next person's ring with the call that
   * just finished — the mentor sees a finished-call screen and the queue appears frozen.
   *
   * Returns false when the result was dropped for that reason.
   */
  const applyEnded = useCallback((updated: SessionView): boolean => {
    if (sessionRef.current && sessionRef.current.id !== updated.id) return false;
    sessionRef.current = updated;
    setSession(updated);
    setPhase('ended');
    setEndReason(updated.endReason);
    setCredentials(null);
    setQueue(null);
    return true;
  }, []);

  const acceptCall = useCallback(async () => {
    if (!session) return;
    setBusy(true);
    setError(null);
    try {
      const result = await acceptSession(session.id);
      applySession(result.session, result.credentials, { queue: result.queue });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not accept call');
    } finally {
      setBusy(false);
    }
  }, [session, applySession]);

  const declineCall = useCallback(async () => {
    if (!session) return;
    setBusy(true);
    setError(null);
    try {
      applyEnded(await declineSession(session.id));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not decline call');
    } finally {
      setBusy(false);
    }
  }, [session, applyEnded]);

  const cancelCall = useCallback(async () => {
    if (!session) return;
    setBusy(true);
    setError(null);
    try {
      applyEnded(await cancelSession(session.id));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not cancel call');
    } finally {
      setBusy(false);
    }
  }, [session, applyEnded]);

  /**
   * Give up a place in line. The same `cancel` route as a ringing call — a QUEUED session is
   * cancellable by its caller, and the server takes care of removing the queue entry and
   * moving everyone behind us up.
   */
  const leaveQueue = useCallback(async () => {
    if (!session) return;
    setBusy(true);
    setError(null);
    try {
      // Guarded too: leaving the queue races the promotion that would have made this a call.
      if (applyEnded(await cancelSession(session.id))) {
        setQueueExitReason('CANCELLED_BY_USER');
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not leave the queue');
    } finally {
      setBusy(false);
    }
  }, [session, applyEnded]);

  const hangUp = useCallback(async () => {
    if (!session) return;
    setBusy(true);
    setError(null);
    try {
      // **The one that mattered.** Ending a call dispatches the mentor's queue inside the same
      // request, so the next caller's ring has already arrived by the time this resolves.
      applyEnded(await endSession(session.id));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not end call');
    } finally {
      setBusy(false);
    }
  }, [session, applyEnded]);

  const value = useMemo<CallContextValue>(
    () => ({
      phase,
      session,
      credentials,
      queue,
      queueExitReason,
      ringExpiresAtMs,
      endReason,
      error,
      busy,
      startVoiceCall,
      startTextChat,
      acceptCall,
      declineCall,
      cancelCall,
      leaveQueue,
      hangUp,
      dismissEnded: resetCall,
      clearError: () => setError(null),
    }),
    [
      phase,
      session,
      credentials,
      queue,
      queueExitReason,
      ringExpiresAtMs,
      endReason,
      error,
      busy,
      startVoiceCall,
      startTextChat,
      acceptCall,
      declineCall,
      cancelCall,
      leaveQueue,
      hangUp,
      resetCall,
    ],
  );

  return <CallContext.Provider value={value}>{children}</CallContext.Provider>;
}

export function useCall(): CallContextValue {
  const ctx = useContext(CallContext);
  if (!ctx) {
    throw new Error('useCall must be used within CallProvider');
  }
  return ctx;
}

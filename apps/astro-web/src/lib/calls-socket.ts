import type {
  CallJoinCredentials,
  QueueLeaveReason,
  QueuePositionView,
  SessionView,
} from '@astro/contracts';
import type { CallsAckError } from '@astro/contracts/sockets';

import { getSocketManager, emitSocketWithAck } from './socket';

/** Must match `CALLS_NAMESPACE` in @astro/contracts/sockets. */
const CALLS_NAMESPACE = '/calls';

type TokenProvider = () => Promise<string | null>;

let callsSocket: import('socket.io-client').Socket | null = null;
let tokenProvider: TokenProvider = async () => null;
let readyPromise: Promise<void> | null = null;

export function setCallsTokenProvider(provider: TokenProvider): void {
  tokenProvider = provider;
}

export async function connectCalls(): Promise<import('socket.io-client').Socket> {
  if (callsSocket?.connected && readyPromise) {
    await readyPromise;
    return callsSocket;
  }

  const token = await tokenProvider();
  if (!token) {
    throw new Error('Not authenticated');
  }

  if (callsSocket) {
    callsSocket.disconnect();
    callsSocket.removeAllListeners();
  }

  const socket = getSocketManager().socket(CALLS_NAMESPACE);
  callsSocket = socket;

  readyPromise = new Promise<void>((resolve, reject) => {
    const onReady = () => {
      socket.off('connect_error', onError);
      resolve();
    };
    const onError = (err: Error) => {
      socket.off('calls:ready', onReady);
      reject(err);
    };
    socket.once('calls:ready', onReady);
    socket.once('connect_error', onError);
  });

  socket.auth = { token };
  socket.connect();

  await readyPromise;
  return socket;
}

export function disconnectCalls(): void {
  if (callsSocket) {
    callsSocket.disconnect();
    callsSocket.removeAllListeners();
    callsSocket = null;
  }
  readyPromise = null;
}

/**
 * A `type`, not an `interface`: `emitSocketWithAck` constrains its payload to
 * `Record<string, unknown>`, and only type aliases get the implicit index signature.
 */
export type CallsResyncResult = {
  session: SessionView | null;
  credentials: CallJoinCredentials | null;
  /** Present only while the session is QUEUED. */
  queue: QueuePositionView | null;
};

export async function callsResync(): Promise<CallsResyncResult> {
  const socket = await connectCalls();
  const result = await emitSocketWithAck<CallsResyncResult, CallsAckError>(
    socket,
    'calls:resync',
    {},
  );
  if (!result.ok) {
    throw new Error(result.error);
  }
  // The position has to come back in this round trip. A client that reloaded mid-wait would
  // otherwise show no place in line until the next person happened to leave the queue.
  return { session: result.session, credentials: result.credentials, queue: result.queue };
}

export interface CallsEventHandlers {
  onIncoming?: (payload: { session: SessionView; ringExpiresAtMs: number }) => void;
  onState?: (payload: { session: SessionView }) => void;
  onConnected?: (payload: { sessionId: string; billingAnchorAt: string }) => void;
  onEnded?: (payload: {
    sessionId: string;
    endReason: string;
    endedAt: string;
    billedSeconds: number | null;
  }) => void;
  /**
   * The caller's place in line changed. Re-sent to everyone still waiting each time somebody
   * leaves, so this fires for departures ahead of us, not only for our own enqueue.
   */
  onQueuePosition?: (payload: QueuePositionView) => void;
  /**
   * We stopped waiting without being promoted. `PROMOTED` never arrives here — that is a
   * `calls:state` transition to RINGING, because from this side the wait became a call.
   */
  onQueueLeft?: (payload: {
    sessionId: string;
    reason: Exclude<QueueLeaveReason, 'PROMOTED'>;
  }) => void;
}

export function bindCallsHandlers(handlers: CallsEventHandlers): () => void {
  let socket: import('socket.io-client').Socket | null = null;
  // The connect is async, so an unmount can land before it resolves. Without this flag the
  // `.then` would attach listeners nothing will ever detach, and a remount would then count
  // every `queue:position` twice.
  let disposed = false;

  const detach = (s: import('socket.io-client').Socket) => {
    if (handlers.onIncoming) s.off('calls:incoming', handlers.onIncoming);
    if (handlers.onState) s.off('calls:state', handlers.onState);
    if (handlers.onConnected) s.off('calls:connected', handlers.onConnected);
    if (handlers.onEnded) s.off('calls:ended', handlers.onEnded);
    if (handlers.onQueuePosition) s.off('queue:position', handlers.onQueuePosition);
    if (handlers.onQueueLeft) s.off('queue:left', handlers.onQueueLeft);
  };

  void connectCalls().then((s) => {
    if (disposed) return;
    socket = s;
    if (handlers.onIncoming) s.on('calls:incoming', handlers.onIncoming);
    if (handlers.onState) s.on('calls:state', handlers.onState);
    if (handlers.onConnected) s.on('calls:connected', handlers.onConnected);
    if (handlers.onEnded) s.on('calls:ended', handlers.onEnded);
    if (handlers.onQueuePosition) s.on('queue:position', handlers.onQueuePosition);
    if (handlers.onQueueLeft) s.on('queue:left', handlers.onQueueLeft);
  });

  return () => {
    disposed = true;
    if (socket) detach(socket);
  };
}

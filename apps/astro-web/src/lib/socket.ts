import type { PresenceState } from '@astro/contracts';
import type {
  MentorPresenceSnapshot,
  PresenceAckError,
} from '@astro/contracts/sockets';
import { Manager, Socket } from 'socket.io-client';

import { API_URL } from './api';

/** Must match `PRESENCE_NAMESPACE` in @astro/contracts/sockets. */
const PRESENCE_NAMESPACE = '/presence';

type TokenProvider = () => Promise<string | null>;

let manager: Manager | null = null;
let presenceSocket: Socket | null = null;
let tokenProvider: TokenProvider = async () => null;
let readyPromise: Promise<void> | null = null;

export function setSocketTokenProvider(provider: TokenProvider): void {
  tokenProvider = provider;
}

export function getSocketManager(): Manager {
  if (!manager) {
    manager = new Manager(API_URL, {
      autoConnect: false,
      transports: ['websocket', 'polling'],
      ...(API_URL.includes('ngrok-free.app')
        ? { extraHeaders: { 'ngrok-skip-browser-warning': 'true' } }
        : {}),
    });
  }
  return manager;
}

function getManager(): Manager {
  return getSocketManager();
}

export function emitSocketWithAck<T extends Record<string, unknown>, E extends string>(
  socket: Socket,
  event: string,
  payload?: unknown,
): Promise<({ ok: true } & T) | { ok: false; error: E }> {
  return new Promise((resolve) => {
    const callback = (result: ({ ok: true } & T) | { ok: false; error: E }) => {
      resolve(result);
    };
    if (payload === undefined) {
      socket.emit(event, callback);
    } else {
      socket.emit(event, payload, callback);
    }
  });
}

export async function connectPresence(): Promise<Socket> {
  if (presenceSocket?.connected && readyPromise) {
    await readyPromise;
    return presenceSocket;
  }

  const token = await tokenProvider();
  if (!token) {
    throw new Error('Not authenticated');
  }

  if (presenceSocket) {
    presenceSocket.disconnect();
    presenceSocket.removeAllListeners();
  }

  const socket = getManager().socket(PRESENCE_NAMESPACE);
  presenceSocket = socket;

  readyPromise = new Promise<void>((resolve, reject) => {
    const onReady = () => {
      socket.off('connect_error', onError);
      resolve();
    };
    const onError = (err: Error) => {
      socket.off('presence:ready', onReady);
      reject(err);
    };
    socket.once('presence:ready', onReady);
    socket.once('connect_error', onError);
  });

  socket.auth = { token };
  socket.connect();

  await readyPromise;
  return socket;
}

export function disconnectPresence(): void {
  if (presenceSocket) {
    presenceSocket.disconnect();
    presenceSocket.removeAllListeners();
    presenceSocket = null;
  }
  readyPromise = null;
}

export async function subscribePresence(params: {
  categorySlugs?: string[];
  mentorProfileIds?: string[];
}): Promise<MentorPresenceSnapshot[]> {
  const socket = await connectPresence();
  const result = await emitSocketWithAck<{ snapshot: MentorPresenceSnapshot[] }, PresenceAckError>(
    socket,
    'presence:subscribe',
    params,
  );
  if (!result.ok) {
    throw new Error(result.error);
  }
  return result.snapshot;
}

export function onPresenceChanged(
  handler: (snapshot: MentorPresenceSnapshot) => void,
): () => void {
  void connectPresence().then((socket) => {
    socket.on('presence:changed', handler);
  });
  return () => {
    presenceSocket?.off('presence:changed', handler);
  };
}

export async function mentorGoOnline(
  acceptingNewCalls = true,
): Promise<{ state: PresenceState; ttlSeconds: number }> {
  const socket = await connectPresence();
  const result = await emitSocketWithAck<
    { state: PresenceState; ttlSeconds: number },
    PresenceAckError
  >(socket, 'mentor:go-online', { acceptingNewCalls });
  if (!result.ok) {
    throw new Error(result.error);
  }
  return { state: result.state, ttlSeconds: result.ttlSeconds };
}

export async function mentorGoOffline(): Promise<void> {
  const socket = await connectPresence();
  const result = await emitSocketWithAck<{ state: 'OFFLINE' }, PresenceAckError>(
    socket,
    'mentor:go-offline',
    {},
  );
  if (!result.ok) {
    throw new Error(result.error);
  }
}

export async function mentorSetAccepting(accepting: boolean): Promise<boolean> {
  const socket = await connectPresence();
  const result = await emitSocketWithAck<{ acceptingNewCalls: boolean }, PresenceAckError>(
    socket,
    'mentor:set-accepting',
    { accepting },
  );
  if (!result.ok) {
    throw new Error(result.error);
  }
  return result.acceptingNewCalls;
}

export async function presenceHeartbeat(): Promise<number> {
  const socket = await connectPresence();
  const result = await emitSocketWithAck<{ ttlSeconds: number }, PresenceAckError>(
    socket,
    'presence:heartbeat',
  );
  if (!result.ok) {
    throw new Error(result.error);
  }
  return result.ttlSeconds;
}

/** Default heartbeat interval — matches API default PRESENCE_HEARTBEAT_S. */
export const HEARTBEAT_INTERVAL_MS = 15_000;

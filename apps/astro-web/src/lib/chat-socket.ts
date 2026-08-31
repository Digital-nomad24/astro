import type {
  ChatHistoryPage,
  ChatMessageView,
  ChatRetentionNotice,
} from '@astro/contracts';
import type { ChatAckError } from '@astro/contracts/sockets';

import { emitSocketWithAck, getSocketManager } from './socket';

/** Must match `CHAT_NAMESPACE` in @astro/contracts/sockets. */
const CHAT_NAMESPACE = '/chat';

type TokenProvider = () => Promise<string | null>;

let chatSocket: import('socket.io-client').Socket | null = null;
let tokenProvider: TokenProvider = async () => null;
let readyPromise: Promise<void> | null = null;
let connectInFlight: Promise<import('socket.io-client').Socket> | null = null;

export function setChatTokenProvider(provider: TokenProvider): void {
  tokenProvider = provider;
}

async function openChatSocket(): Promise<import('socket.io-client').Socket> {
  const token = await tokenProvider();
  if (!token) {
    throw new Error('Not authenticated');
  }

  if (chatSocket?.connected) {
    return chatSocket;
  }

  if (chatSocket) {
    chatSocket.disconnect();
    chatSocket.removeAllListeners();
  }

  const socket = getSocketManager().socket(CHAT_NAMESPACE);
  chatSocket = socket;

  readyPromise = new Promise<void>((resolve, reject) => {
    const onReady = () => {
      socket.off('connect_error', onError);
      resolve();
    };
    const onError = (err: Error) => {
      socket.off('chat:ready', onReady);
      reject(err);
    };
    socket.once('chat:ready', onReady);
    socket.once('connect_error', onError);
  });

  socket.auth = { token };
  socket.connect();

  await readyPromise;
  return socket;
}

/** Connect once; concurrent callers share the same in-flight promise. */
export async function connectChat(): Promise<import('socket.io-client').Socket> {
  if (chatSocket?.connected) {
    return chatSocket;
  }

  if (connectInFlight) {
    return connectInFlight;
  }

  connectInFlight = openChatSocket().finally(() => {
    connectInFlight = null;
  });

  return connectInFlight;
}

export function disconnectChat(): void {
  if (chatSocket) {
    chatSocket.disconnect();
    chatSocket.removeAllListeners();
    chatSocket = null;
  }
  readyPromise = null;
  connectInFlight = null;
}

export async function chatJoin(sessionId: string): Promise<{
  history: ChatHistoryPage;
  retention: ChatRetentionNotice;
}> {
  const socket = await connectChat();
  const result = await emitSocketWithAck<
    { history: ChatHistoryPage; retention: ChatRetentionNotice },
    ChatAckError
  >(socket, 'chat:join', { sessionId });
  if (!result.ok) {
    throw new Error(result.error);
  }
  return { history: result.history, retention: result.retention };
}

export async function chatLeave(sessionId: string): Promise<void> {
  const socket = await connectChat();
  const result = await emitSocketWithAck<Record<never, never>, ChatAckError>(
    socket,
    'chat:leave',
    { sessionId },
  );
  if (!result.ok) {
    throw new Error(result.error);
  }
}

export async function chatSend(
  sessionId: string,
  body: string,
  clientMsgId: string,
): Promise<{ message: ChatMessageView; duplicate: boolean }> {
  const socket = await connectChat();
  const result = await emitSocketWithAck<
    { message: ChatMessageView; duplicate: boolean },
    ChatAckError
  >(socket, 'chat:send', { sessionId, body, clientMsgId });
  if (!result.ok) {
    throw new Error(result.error);
  }
  return { message: result.message, duplicate: result.duplicate };
}

export async function chatHistory(
  sessionId: string,
  before?: string,
  limit?: number,
): Promise<ChatHistoryPage> {
  const socket = await connectChat();
  const result = await emitSocketWithAck<{ history: ChatHistoryPage }, ChatAckError>(
    socket,
    'chat:history',
    { sessionId, before, limit },
  );
  if (!result.ok) {
    throw new Error(result.error);
  }
  return result.history;
}

export async function chatTyping(sessionId: string): Promise<void> {
  const socket = await connectChat();
  const result = await emitSocketWithAck<Record<never, never>, ChatAckError>(
    socket,
    'chat:typing',
    { sessionId },
  );
  if (!result.ok) {
    throw new Error(result.error);
  }
}

export interface ChatEventHandlers {
  onMessage?: (message: ChatMessageView) => void;
  onTyping?: (payload: { sessionId: string; userId: string }) => void;
  onEnded?: (payload: { sessionId: string; endReason: string; endedAt: string }) => void;
  onPurged?: (payload: { sessionId: string; purgedAt: string; messageCount: number }) => void;
}

/** Registers push handlers on the live chat socket. Must complete before relying on delivery. */
export async function bindChatHandlers(handlers: ChatEventHandlers): Promise<() => void> {
  const socket = await connectChat();

  if (handlers.onMessage) socket.on('chat:message', handlers.onMessage);
  if (handlers.onTyping) socket.on('chat:typing', handlers.onTyping);
  if (handlers.onEnded) socket.on('chat:ended', handlers.onEnded);
  if (handlers.onPurged) socket.on('chat:purged', handlers.onPurged);

  return () => {
    if (handlers.onMessage) socket.off('chat:message', handlers.onMessage);
    if (handlers.onTyping) socket.off('chat:typing', handlers.onTyping);
    if (handlers.onEnded) socket.off('chat:ended', handlers.onEnded);
    if (handlers.onPurged) socket.off('chat:purged', handlers.onPurged);
  };
}

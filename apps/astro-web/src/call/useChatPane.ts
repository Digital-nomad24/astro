import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type { ChatMessageView, ChatRetentionNotice } from '@astro/contracts';

import {
  bindChatHandlers,
  chatJoin,
  chatLeave,
  chatSend,
  chatTyping,
} from '../lib/chat-socket';

/** API returns newest-first; chat UI renders oldest at top. */
export function sortMessagesOldestFirst(messages: readonly ChatMessageView[]): ChatMessageView[] {
  return [...messages].sort(
    (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
  );
}

interface UseChatPaneOptions {
  sessionId: string | null;
  active: boolean;
  currentUserId: string | null;
}

export function useChatPane({ sessionId, active, currentUserId }: UseChatPaneOptions) {
  const [messages, setMessages] = useState<ChatMessageView[]>([]);
  const [retention, setRetention] = useState<ChatRetentionNotice | null>(null);
  const [purged, setPurged] = useState(false);
  const [typingUserId, setTypingUserId] = useState<string | null>(null);
  const [sendError, setSendError] = useState<string | null>(null);
  const [joined, setJoined] = useState(false);
  const pendingClientIds = useRef(new Set<string>());
  const typingTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastTypingSent = useRef(0);

  const mergeMessage = useCallback((msg: ChatMessageView) => {
    setMessages((prev) => {
      if (prev.some((m) => m.clientMsgId === msg.clientMsgId || m.id === msg.id)) {
        return prev;
      }
      return sortMessagesOldestFirst([...prev, msg]);
    });
  }, []);

  useEffect(() => {
    if (!sessionId || !active || !currentUserId) {
      setJoined(false);
      setMessages([]);
      setRetention(null);
      setPurged(false);
      return;
    }

    let cancelled = false;
    let unbind: (() => void) | undefined;

    void (async () => {
      try {
        unbind = await bindChatHandlers({
          onMessage: (msg) => {
            if (msg.sessionId !== sessionId) return;
            pendingClientIds.current.delete(msg.clientMsgId);
            mergeMessage(msg);
          },
          onTyping: ({ sessionId: sid, userId }) => {
            if (sid !== sessionId || userId === currentUserId) return;
            setTypingUserId(userId);
            if (typingTimer.current) clearTimeout(typingTimer.current);
            typingTimer.current = setTimeout(() => setTypingUserId(null), 3000);
          },
          onPurged: ({ sessionId: sid }) => {
            if (sid !== sessionId) return;
            setPurged(true);
            setMessages([]);
          },
        });
        if (cancelled) {
          unbind();
          return;
        }

        const result = await chatJoin(sessionId);
        if (cancelled) return;

        setRetention(result.retention);
        setPurged(result.history.purgedAt != null);
        setMessages(sortMessagesOldestFirst(result.history.messages));
        setJoined(true);
      } catch (err) {
        if (!cancelled) {
          setSendError(err instanceof Error ? err.message : 'Could not join chat');
        }
      }
    })();

    return () => {
      cancelled = true;
      unbind?.();
      if (typingTimer.current) clearTimeout(typingTimer.current);
      if (sessionId) {
        void chatLeave(sessionId).catch(() => undefined);
      }
      setJoined(false);
    };
  }, [sessionId, active, currentUserId, mergeMessage]);

  const sendMessage = useCallback(
    async (body: string) => {
      if (!sessionId || !joined) return;
      const trimmed = body.trim();
      if (!trimmed) return;

      const clientMsgId = crypto.randomUUID();
      const optimistic: ChatMessageView = {
        id: `optimistic-${clientMsgId}`,
        sessionId,
        senderUserId: currentUserId ?? '',
        body: trimmed,
        createdAt: new Date().toISOString(),
        clientMsgId,
      };

      pendingClientIds.current.add(clientMsgId);
      mergeMessage(optimistic);
      setSendError(null);

      try {
        const result = await chatSend(sessionId, trimmed, clientMsgId);
        pendingClientIds.current.delete(clientMsgId);
        if (!result.duplicate) {
          setMessages((prev) =>
            sortMessagesOldestFirst(
              prev
                .filter((m) => m.clientMsgId !== clientMsgId)
                .concat(result.message),
            ),
          );
        }
      } catch (err) {
        pendingClientIds.current.delete(clientMsgId);
        setMessages((prev) => prev.filter((m) => m.clientMsgId !== clientMsgId));
        setSendError(formatChatError(err));
      }
    },
    [sessionId, joined, currentUserId, mergeMessage],
  );

  const notifyTyping = useCallback(() => {
    if (!sessionId || !joined) return;
    const now = Date.now();
    if (now - lastTypingSent.current < 2000) return;
    lastTypingSent.current = now;
    void chatTyping(sessionId).catch(() => undefined);
  }, [sessionId, joined]);

  const isTyping = typingUserId != null;

  return useMemo(
    () => ({
      messages,
      retention,
      purged,
      joined,
      sendError,
      isTyping,
      sendMessage,
      notifyTyping,
      clearSendError: () => setSendError(null),
    }),
    [
      messages,
      retention,
      purged,
      joined,
      sendError,
      isTyping,
      sendMessage,
      notifyTyping,
    ],
  );
}

/** Max message length — must match server `CHAT_MESSAGE_MAX_LENGTH`. */
export const CHAT_MESSAGE_MAX_LENGTH = 4000;

function formatChatError(err: unknown): string {
  const code = err instanceof Error ? err.message : String(err);
  switch (code) {
    case 'rate_limited':
      return 'Slow down — try again in a moment';
    case 'message_too_long':
      return `Message must be ${CHAT_MESSAGE_MAX_LENGTH} characters or fewer`;
    case 'transcript_purged':
      return 'This transcript has been deleted';
    case 'session_not_active':
      return 'This chat has ended';
    case 'not_joined':
      return 'Reconnecting to chat…';
    default:
      return code || 'Send failed';
  }
}

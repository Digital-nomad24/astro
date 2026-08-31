import { useEffect, useRef, useState } from 'react';

import { useAuth } from '../auth/AuthProvider';
import { CHAT_MESSAGE_MAX_LENGTH, useChatPane } from '../call/useChatPane';

interface ChatPaneProps {
  sessionId: string;
  title: string;
  billingAnchorAt: string | null;
  onEnd: () => void;
  endBusy: boolean;
}

function formatElapsed(anchorIso: string): string {
  const seconds = Math.max(0, Math.floor((Date.now() - new Date(anchorIso).getTime()) / 1000));
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

export function ChatPane({
  sessionId,
  title,
  billingAnchorAt,
  onEnd,
  endBusy,
}: ChatPaneProps) {
  const { me } = useAuth();
  const listRef = useRef<HTMLDivElement>(null);
  const [draft, setDraft] = useState('');

  const chat = useChatPane({
    sessionId,
    active: true,
    currentUserId: me?.id ?? null,
  });

  useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [chat.messages.length]);

  const [timer, setTimer] = useState('');
  useEffect(() => {
    if (!billingAnchorAt) {
      setTimer('');
      return;
    }
    const tick = () => setTimer(formatElapsed(billingAnchorAt));
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [billingAnchorAt]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const text = draft.trim();
    if (!text) return;
    setDraft('');
    await chat.sendMessage(text);
  }

  return (
    <div className="chat-pane">
      <header className="chat-pane-header">
        <div>
          <p className="eyebrow">Text consultation</p>
          <h2>{title}</h2>
        </div>
        <div className="chat-pane-meta">
          {billingAnchorAt ? (
            <span className="chat-timer">{timer}</span>
          ) : (
            <span className="muted">Starts on first message</span>
          )}
        </div>
      </header>

      {chat.retention?.deleteAfter && (
        <p className="chat-retention muted">
          Transcript deleted after{' '}
          {new Date(chat.retention.deleteAfter).toLocaleDateString()}
        </p>
      )}

      {chat.purged && (
        <p className="status-banner">This transcript has been deleted under retention policy.</p>
      )}

      {chat.sendError && (
        <p className="error-banner">
          {chat.sendError}
          <button type="button" className="link-btn" onClick={chat.clearSendError}>
            Dismiss
          </button>
        </p>
      )}

      <div className="chat-messages" ref={listRef}>
        {!chat.joined && !chat.purged && <p className="muted">Connecting chat…</p>}
        {chat.messages.map((msg) => {
          const mine = msg.senderUserId === me?.id;
          return (
            <div
              key={msg.clientMsgId}
              className={`chat-bubble-row${mine ? ' mine' : ''}`}
            >
              <div className={`chat-bubble${mine ? ' mine' : ''}`}>{msg.body}</div>
            </div>
          );
        })}
        {chat.isTyping && <p className="chat-typing muted">Typing…</p>}
      </div>

      <form className="chat-composer" onSubmit={(e) => void handleSubmit(e)}>
        <textarea
          value={draft}
          onChange={(e) => {
            setDraft(e.target.value.slice(0, CHAT_MESSAGE_MAX_LENGTH));
            chat.notifyTyping();
          }}
          placeholder="Type a message…"
          rows={2}
          disabled={!chat.joined || chat.purged}
        />
        <div className="chat-composer-actions">
          <span className="hint">
            {draft.length}/{CHAT_MESSAGE_MAX_LENGTH}
          </span>
          <div className="chat-composer-btns">
            <button
              type="button"
              className="btn ghost"
              disabled={endBusy}
              onClick={onEnd}
            >
              End chat
            </button>
            <button
              type="submit"
              className="btn primary"
              disabled={!chat.joined || chat.purged || !draft.trim()}
            >
              Send
            </button>
          </div>
        </div>
      </form>
    </div>
  );
}

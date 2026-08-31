/** One message as any client renders it. */
export interface ChatMessageView {
  readonly id: string;
  readonly sessionId: string;
  readonly senderUserId: string;
  readonly body: string;
  /** ISO. Server-stamped — a client clock is both wrong and adversarial. */
  readonly createdAt: string;
  /**
   * Echoed back so the sender can reconcile its optimistic bubble with the stored row rather
   * than rendering the message twice.
   */
  readonly clientMsgId: string;
}

/**
 * A page of history, newest first.
 *
 * `purgedAt` is the difference between "this conversation had no messages" and "the
 * transcript has been deleted", which are the same empty array otherwise. A client that
 * cannot tell them apart will show an empty chat pane for a consultation that definitely
 * happened.
 */
export interface ChatHistoryPage {
  readonly messages: readonly ChatMessageView[];
  /** Null when there is nothing older. Opaque — do not parse it. */
  readonly nextCursor: string | null;
  /** ISO timestamp of the purge, or null while the transcript is still retained. */
  readonly purgedAt: string | null;
  /** Survives the purge, so "14 messages, transcript deleted" stays renderable. */
  readonly messageCount: number;
}

/**
 * Transcript retention, as the client needs to explain it to a user.
 *
 * Sent on join so the UI can say "this conversation will be deleted on the 17th" rather than
 * having the transcript silently vanish between two visits.
 */
export interface ChatRetentionNotice {
  readonly retentionDays: number;
  /** ISO. Null while the session is still live — retention is measured from the end. */
  readonly deleteAfter: string | null;
}

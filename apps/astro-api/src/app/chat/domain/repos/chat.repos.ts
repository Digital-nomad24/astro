import type { PageCursor } from '../../../common/pagination/cursor';

export interface IChatMessageRecord {
  readonly id: string;
  readonly sessionId: string;
  readonly senderUserId: string;
  readonly body: string;
  readonly clientMsgId: string;
  readonly createdAt: Date;
}

export interface IAppendMessageParams {
  readonly sessionId: string;
  readonly senderUserId: string;
  readonly body: string;
  readonly clientMsgId: string;
  readonly at: Date;
}

export interface IAppendMessageResult {
  readonly message: IChatMessageRecord;
  /** True when this `clientMsgId` had already been stored — a retry, not a new message. */
  readonly duplicate: boolean;
  /** True when THIS message stamped `billingAnchorAt`, i.e. the conversation just started. */
  readonly anchored: boolean;
}

/** Why a transcript is being deleted. Recorded in the audit log, not in the database. */
export type PurgeReason = 'SUMMARISED' | 'RETENTION_BACKSTOP';

export interface IPurgeCandidate {
  readonly sessionId: string;
  readonly endedAt: Date;
  readonly messageCount: number;
  readonly reason: PurgeReason;
}

export interface IIdleSessionCandidate {
  readonly sessionId: string;
  /** Last message, or the accept time when nobody has spoken at all. */
  readonly lastActivityAt: Date;
}

/**
 * The transcript store.
 *
 * This repo also owns four columns that physically live on the `Session` row —
 * `lastMessageAt`, `messageCount` and `messagesPurgedAt`, plus the conditional stamp of
 * `billingAnchorAt` on the first message. They are denormalised onto `Session` so the idle
 * and retention sweeps are single indexed scans instead of aggregates over `ChatMessage`, but
 * the ownership is here and `ISessionRepo` never writes them. The alternative — splitting the
 * append across two repos — would put the message and its counter in different transactions,
 * which is exactly the atomicity this design exists to keep.
 */
export interface IChatMessageRepo {
  /**
   * Appends one message, updates the session's activity counters, and stamps the billing
   * anchor if this is the first message — all in one transaction.
   *
   * Throws `ConflictError('SESSION_NOT_ACTIVE')` if the session is not ACTIVE at commit time.
   * That check is inside the transaction rather than a read before it, so a session that ends
   * mid-send cannot accept one last message.
   */
  append(params: IAppendMessageParams): Promise<IAppendMessageResult>;

  /** Newest first. Returns `limit + 1` rows so the caller can detect another page. */
  history(
    sessionId: string,
    limit: number,
    cursor: PageCursor | null,
  ): Promise<IChatMessageRecord[]>;

  /** ACTIVE text sessions with no activity since the cutoff. */
  findIdleTextSessions(cutoff: Date, limit: number): Promise<IIdleSessionCandidate[]>;

  /**
   * Transcripts that may now be deleted.
   *
   * Two arms, and both are needed. `SUMMARISED` is the intended path — past the retention
   * window and the summary is safely stored, so the transcript has served its purpose.
   * `RETENTION_BACKSTOP` is everything that is simply too old, summarised or not, because
   * delete-on-success alone leaks transcripts forever whenever the summariser is broken.
   *
   * Until M8 exists nothing can be summarised, so today every candidate arrives via the
   * backstop. The seam is here so M8 changes one method rather than the sweeper.
   */
  findPurgeableTranscripts(params: {
    readonly retentionCutoff: Date;
    readonly hardCutoff: Date;
    readonly limit: number;
  }): Promise<IPurgeCandidate[]>;

  /**
   * Deletes a transcript and stamps `messagesPurgedAt`, in one transaction. Returns the number
   * of messages removed. Idempotent: a session already purged deletes nothing and keeps its
   * original timestamp.
   */
  purgeTranscript(sessionId: string, at: Date): Promise<number>;
}

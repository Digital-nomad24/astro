import { IsInt, IsOptional, IsString, Max, MaxLength, Min, MinLength } from 'class-validator';

/**
 * Socket DTOs, validated by the gateway's own `@UsePipes(ValidationPipe)` — the global pipe
 * does not reach WebSocket payloads.
 *
 * Note what is NOT enforced here: message length. A body over the limit is answered with a
 * typed `message_too_long` ack from inside the handler, because a `ValidationPipe` rejection
 * throws, and a throw inside a `@SubscribeMessage` handler never reaches the ack callback —
 * the client just waits forever. Anything a well-behaved client can plausibly do wrong has to
 * come back as an ack, not an exception. The same lesson the presence gateway learned from
 * over-long subscription lists.
 */
export class ChatJoinDto {
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  sessionId!: string;
}

export class ChatHistoryDto {
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  sessionId!: string;

  /** Opaque cursor from the previous page. */
  @IsOptional()
  @IsString()
  @MaxLength(512)
  before?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(200)
  limit?: number;
}

export class ChatSendDto {
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  sessionId!: string;

  /**
   * Bounded generously here purely as a transport guard against an absurd payload; the real
   * limit is `CHAT_MESSAGE_MAX_LENGTH` and is checked in the handler so it can answer with an
   * ack the client can show the user.
   */
  @IsString()
  @MinLength(1)
  @MaxLength(20_000)
  body!: string;

  /**
   * Required, not optional. It is what makes a retry after a reconnect idempotent, so a client
   * that omits it would double-post on every flaky connection.
   */
  @IsString()
  @MinLength(1)
  @MaxLength(128)
  clientMsgId!: string;
}

export class ChatTypingDto {
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  sessionId!: string;
}

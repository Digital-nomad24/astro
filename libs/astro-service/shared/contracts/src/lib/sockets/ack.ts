/**
 * Every client→server socket event answers with one of these. Handlers **return** an ack;
 * they never throw. A thrown error inside a `@SubscribeMessage` handler is invisible to the
 * client — it just never gets its callback — so the discriminated union is the only way the
 * caller can tell "denied" from "dropped".
 */
export type Ok<T = Record<never, never>> = { ok: true } & T;
export type Err<E extends string = string> = { ok: false; error: E };
export type Ack<T = Record<never, never>, E extends string = string> = Ok<T> | Err<E>;

/**
 * Errors any handler may return. Namespace-specific handlers widen this with their own
 * literals, e.g. `Ack<{ messageId: string }, CommonAckError | 'session_not_active'>`.
 */
export const COMMON_ACK_ERRORS = [
  'unauthorized',
  'forbidden',
  'not_found',
  'invalid_payload',
  'rate_limited',
  'internal',
] as const;
export type CommonAckError = (typeof COMMON_ACK_ERRORS)[number];

export const ok = <T extends Record<string, unknown>>(payload?: T): Ok<T> =>
  ({ ok: true, ...(payload ?? ({} as T)) }) as Ok<T>;

export const err = <E extends string>(error: E): Err<E> => ({ ok: false, error });

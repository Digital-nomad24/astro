/**
 * The billing clock.
 *
 * The single most important property here: **the interval index is derived from two
 * timestamps, never counted.** Because it is a pure function of `(anchorAt, at)`, a missed
 * sweeper tick is not lost revenue and a duplicated tick is not a double charge — the
 * sweeper simply charges every index it has not charged yet, and the ledger's
 * `@@unique([sessionId, intervalIndex])` rejects the rest.
 *
 * Billing is **prepaid per interval**: index 0 is owed the moment the session anchors, index
 * 1 at `+intervalSeconds`, and so on. Partial intervals are not refunded.
 *
 * These functions are shared with the web client so the countdown a user sees and the amount
 * they are charged are computed by the same code.
 */

/** Returned when `at` precedes the anchor — the session has not started billing yet. */
export const NOT_STARTED = -1;

/**
 * Index of the interval in progress at `atMs`, or `NOT_STARTED` if billing has not begun.
 *
 * `anchorAtMs` is `Session.billingAnchorAt`: for VOICE the LiveKit `participant_joined`
 * webhook for the second party, for TEXT the first message. A null anchor means the session
 * is not billable yet and callers should not be here at all.
 */
export function billingIntervalIndex(
  anchorAtMs: number,
  atMs: number,
  intervalSeconds: number,
): number {
  assertPositive(intervalSeconds, 'intervalSeconds');
  if (atMs < anchorAtMs) return NOT_STARTED;
  return Math.floor((atMs - anchorAtMs) / (intervalSeconds * 1000));
}

/**
 * The indices a sweeper tick should charge: everything after `lastBilledIndex` up to and
 * including the interval in progress.
 *
 * `maxPerTick` bounds the catch-up burst. A session whose sweeper stalled for an hour must
 * not drain a wallet in one commit — it charges what it can and catches up on later ticks,
 * which is also what keeps a clock jump from being indistinguishable from theft.
 */
export function intervalsDue(params: {
  anchorAtMs: number;
  atMs: number;
  intervalSeconds: number;
  /** `-1` when nothing has been charged yet. */
  lastBilledIndex: number;
  maxPerTick: number;
}): number[] {
  const { anchorAtMs, atMs, intervalSeconds, lastBilledIndex, maxPerTick } = params;
  assertPositive(maxPerTick, 'maxPerTick');

  const current = billingIntervalIndex(anchorAtMs, atMs, intervalSeconds);
  if (current === NOT_STARTED) return [];

  const from = lastBilledIndex + 1;
  if (from > current) return [];

  const count = Math.min(current - from + 1, maxPerTick);
  return Array.from({ length: count }, (_, i) => from + i);
}

/**
 * How many whole intervals a balance can pay for at this rate.
 *
 * Guarded against a zero or negative rate: without this, `balance / 0` is `Infinity` and the
 * session gets a `maxDuration` that never elapses — a call that can never be cut off. Rates
 * are also validated at session creation, but the division site guards too, because this is
 * the one that actually produces the unbounded call.
 */
export function affordableIntervals(
  balancePaise: number,
  ratePaisePerInterval: number,
): number {
  if (ratePaisePerInterval <= 0) return 0;
  if (balancePaise <= 0) return 0;
  return Math.floor(balancePaise / ratePaisePerInterval);
}

/**
 * The hard stop for a session, in seconds from its anchor. Computed once at session start so
 * termination is deterministic rather than emergent, and recomputed on a mid-session top-up.
 */
export function maxAffordableSeconds(params: {
  balancePaise: number;
  ratePaisePerInterval: number;
  intervalSeconds: number;
}): number {
  const { balancePaise, ratePaisePerInterval, intervalSeconds } = params;
  assertPositive(intervalSeconds, 'intervalSeconds');
  return affordableIntervals(balancePaise, ratePaisePerInterval) * intervalSeconds;
}

/** Per-interval price derived from a per-minute rate. Exact whenever the interval divides 60. */
export function ratePerInterval(ratePaisePerMinute: number, intervalSeconds: number): number {
  assertPositive(intervalSeconds, 'intervalSeconds');
  return Math.round((ratePaisePerMinute * intervalSeconds) / 60);
}

function assertPositive(value: number, name: string): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive finite number, got ${value}`);
  }
}

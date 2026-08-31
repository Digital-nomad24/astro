import type { SessionEndReason, SessionStatus } from '@astro/contracts';
import { ConflictError } from '@astro/errors';

/**
 * The session state machine, as data.
 *
 * ```
 *                  ┌─ user cancels ──────────────┐
 *                  │                             ▼
 * (created) ─▶ QUEUED ──promote──▶ RINGING ──accept──▶ ACTIVE ──▶ COMPLETED
 *    │  (mentor busy, M6)            │                  │
 *    │                               ├─ decline ───────┐│
 *    └──── mentor free ──────────────┘                 ▼▼
 *           (straight to RINGING)             CANCELLED / FAILED
 * ```
 *
 * Declared as a table rather than scattered `if (status === …)` checks so that the legal
 * transitions can be *read*, and so the unit test can enumerate them exhaustively instead of
 * testing the handful someone remembered.
 *
 * This table is a guard against programmer error, NOT against concurrency. Two requests can
 * both read RINGING and both consider the move to ACTIVE legal. What makes that safe is the
 * conditional `updateMany` in the repo, scoped to the expected prior status: `count === 0`
 * means someone else won. Never read-then-write.
 */
export const SESSION_TRANSITIONS: Readonly<Record<SessionStatus, readonly SessionStatus[]>> = {
  QUEUED: ['RINGING', 'CANCELLED', 'FAILED'],
  RINGING: ['ACTIVE', 'CANCELLED', 'FAILED'],
  ACTIVE: ['COMPLETED', 'FAILED'],
  // Terminal. A session that has ended never changes again — the ledger, the summary and the
  // mentor's earnings all read it after the fact and must see a stable row.
  COMPLETED: [],
  CANCELLED: [],
  FAILED: [],
};

export const TERMINAL_STATUSES = ['COMPLETED', 'CANCELLED', 'FAILED'] as const;

export function isTerminal(status: SessionStatus): boolean {
  return (TERMINAL_STATUSES as readonly SessionStatus[]).includes(status);
}

export function canTransition(from: SessionStatus, to: SessionStatus): boolean {
  return SESSION_TRANSITIONS[from].includes(to);
}

/**
 * Which terminal status each end reason resolves to.
 *
 * The three terminals mean different things and the distinction is load-bearing for M10:
 *
 * - **CANCELLED** — ended before it was ever ACTIVE. Nothing was consumed, so nothing is owed.
 * - **COMPLETED** — was ACTIVE and ended normally, including the balance cutoff. Billable.
 * - **FAILED** — ended because something broke. Billable for whatever actually connected, but
 *   distinguishable in reporting so a spike in media failures is visible rather than buried
 *   among ordinary short calls.
 *
 * `BALANCE_EXHAUSTED` maps to COMPLETED deliberately: from the user's side a call that ran out
 * of money ran to completion, and filing it as a failure would make the healthiest signal in
 * the product look like an incident.
 */
export const TERMINAL_STATUS_FOR_REASON: Readonly<Record<SessionEndReason, SessionStatus>> = {
  COMPLETED_BY_USER: 'COMPLETED',
  COMPLETED_BY_MENTOR: 'COMPLETED',
  BALANCE_EXHAUSTED: 'COMPLETED',
  MAX_DURATION_REACHED: 'COMPLETED',
  IDLE_TIMEOUT: 'COMPLETED',
  ADMIN_TERMINATED: 'COMPLETED',

  RING_TIMEOUT: 'CANCELLED',
  DECLINED: 'CANCELLED',
  CANCELLED_BY_USER: 'CANCELLED',
  MENTOR_OFFLINE: 'CANCELLED',
  QUEUE_EXPIRED: 'CANCELLED',

  MEDIA_FAILURE: 'FAILED',
};

/**
 * Resolves the terminal status for an end reason, given where the session currently is.
 *
 * The reason's *nominal* terminal is not always reachable: a call that reached ACTIVE cannot
 * become CANCELLED, because CANCELLED means "never happened" and this one demonstrably did.
 * The `Session_terminal_has_reason` CHECK does not catch that — it only requires that some
 * reason is present — so this is where the two stay consistent.
 */
export function terminalStatusFor(
  reason: SessionEndReason,
  currentStatus: SessionStatus,
): SessionStatus {
  const nominal = TERMINAL_STATUS_FOR_REASON[reason];
  if (currentStatus === 'ACTIVE' && nominal === 'CANCELLED') return 'COMPLETED';
  return nominal;
}

/**
 * Throws when a transition is not in the table. Used at the *application* boundary — the repo
 * still scopes its update to the prior status, so this produces a clear 409 instead of a
 * silent no-op that the caller has to interpret.
 */
export function assertTransition(from: SessionStatus, to: SessionStatus): void {
  if (!canTransition(from, to)) {
    throw new ConflictError(
      'INVALID_SESSION_TRANSITION',
      `A session cannot go from ${from} to ${to}.`,
      { from, to },
    );
  }
}

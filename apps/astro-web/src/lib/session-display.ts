import type { SessionView } from '@astro/contracts';

/**
 * Who the *other* person was, from the caller's point of view.
 *
 * A session is symmetric — both participants read the same row — so every history surface has
 * to answer this, and each does it wrong in its own way if left to itself. The mentor's side
 * falls back to "Guest" because `User.displayName` is nullable.
 */
export function counterpartName(session: SessionView, meId: string | undefined): string {
  if (session.userId === meId) return session.mentorDisplayName;
  return session.userDisplayName ?? 'Guest';
}

/** True when the caller was the one being consulted. */
export function wasMentor(session: SessionView, meId: string | undefined): boolean {
  return session.mentorUserId === meId;
}

/** `billedSeconds` as a duration. Null before both parties ever connected. */
export function formatBilledDuration(billedSeconds: number | null): string | null {
  if (billedSeconds == null) return null;
  const m = Math.floor(billedSeconds / 60);
  const s = billedSeconds % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

export function formatSessionDate(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

/**
 * How a finished session should read in a list.
 *
 * Deliberately not `endReason` verbatim: `COMPLETED_BY_MENTOR` is an implementation detail of
 * who pressed the button, and a user reading their own history does not care which end hung up.
 * What they need to know is whether it happened, and if not, why not.
 */
export function sessionOutcomeLabel(session: SessionView): string {
  if (session.status === 'QUEUED') return 'Waiting in queue';
  if (session.status === 'RINGING') return 'Ringing';
  if (session.status === 'ACTIVE') return 'In progress';

  switch (session.endReason) {
    case 'COMPLETED_BY_USER':
    case 'COMPLETED_BY_MENTOR':
      return 'Completed';
    case 'DECLINED':
      return 'Declined';
    case 'CANCELLED_BY_USER':
      return 'Cancelled';
    case 'RING_TIMEOUT':
      return 'No answer';
    case 'QUEUE_EXPIRED':
      return 'Left the queue';
    case 'MENTOR_OFFLINE':
      return 'Mentor went offline';
    case 'MEDIA_FAILURE':
      return 'Connection failed';
    case 'IDLE_TIMEOUT':
      return 'Ended — inactive';
    case 'MAX_DURATION_REACHED':
      return 'Ended — time limit';
    case 'BALANCE_EXHAUSTED':
      return 'Ended — out of balance';
    case 'ADMIN_TERMINATED':
      return 'Ended by support';
    default:
      return 'Ended';
  }
}

/** Whether this session ever became a real consultation, as opposed to a call nobody took. */
export function didConnect(session: SessionView): boolean {
  return session.billingAnchorAt !== null;
}

/**
 * What the transcript link should say, or null when there is nothing to open.
 *
 * The three states are genuinely different and a UI that collapses them is wrong: a purged
 * transcript is not an empty one, and neither is a voice call.
 */
export function transcriptStatus(
  session: SessionView,
): { kind: 'readable'; label: string } | { kind: 'purged'; label: string } | null {
  if (session.mode !== 'TEXT') return null;
  if (session.transcriptPurgedAt) {
    return {
      kind: 'purged',
      label: `${session.messageCount} messages · transcript deleted`,
    };
  }
  if (session.messageCount === 0) return null;
  return {
    kind: 'readable',
    label: `Read ${session.messageCount} message${session.messageCount === 1 ? '' : 's'}`,
  };
}

/**
 * Deterministic names for LiveKit rooms and participants.
 *
 * Deterministic matters twice: a webhook only tells us the room name and participant
 * identity, so both must be reversible to our own ids without a lookup table; and a retry of
 * room creation must produce the same room rather than a second one nobody is watching.
 */

const ROOM_PREFIX = 'session';
const IDENTITY_SEPARATOR = ':';

export function roomNameForSession(sessionId: string): string {
  return `${ROOM_PREFIX}${IDENTITY_SEPARATOR}${sessionId}`;
}

/** Inverse of `roomNameForSession`. Returns null for a room we did not create. */
export function sessionIdFromRoomName(roomName: string): string | null {
  const prefix = `${ROOM_PREFIX}${IDENTITY_SEPARATOR}`;
  if (!roomName.startsWith(prefix)) return null;
  const sessionId = roomName.slice(prefix.length);
  return sessionId.length > 0 ? sessionId : null;
}

export type ParticipantRole = 'user' | 'mentor';

/**
 * Participant identity is `<role>:<userId>`. The role is embedded so a
 * `participant_joined` webhook can tell which side arrived — which is what decides whether
 * the billing anchor may be stamped — without a database round trip on the webhook path.
 */
export function participantIdentity(role: ParticipantRole, userId: string): string {
  return `${role}${IDENTITY_SEPARATOR}${userId}`;
}

export function parseParticipantIdentity(
  identity: string,
): { role: ParticipantRole; userId: string } | null {
  const separatorAt = identity.indexOf(IDENTITY_SEPARATOR);
  if (separatorAt <= 0) return null;

  const role = identity.slice(0, separatorAt);
  const userId = identity.slice(separatorAt + 1);
  if (userId.length === 0) return null;
  if (role !== 'user' && role !== 'mentor') return null;

  return { role, userId };
}

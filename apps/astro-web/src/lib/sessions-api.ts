import type { CallJoinCredentials, QueuePositionView, SessionView } from '@astro/contracts';

import { apiGet, apiPost } from './api';
import type { Page } from '../types/api';

export interface StartSessionResult {
  session: SessionView;
  credentials: CallJoinCredentials | null;
  /**
   * Non-null exactly when the session came back QUEUED — the mentor was busy, or somebody was
   * already waiting. Branch on this rather than inferring a queued session from a null
   * `credentials`, which a TEXT session also has.
   */
  queue: QueuePositionView | null;
}

export function startSession(
  mentorProfileId: string,
  mode: 'VOICE' | 'TEXT' = 'VOICE',
): Promise<StartSessionResult> {
  return apiPost<StartSessionResult>('/sessions', { mentorProfileId, mode });
}

export function getActiveSession(): Promise<SessionView | null> {
  return apiGet<SessionView | null>('/sessions/active');
}

export function getSession(sessionId: string): Promise<SessionView> {
  return apiGet<SessionView>(`/sessions/${sessionId}`);
}

/**
 * Past consultations, newest first.
 *
 * `as` picks the side: a mentor has two distinct histories — the people they advised, and the
 * mentors they themselves consulted — and they are different rows, not a filter over one list.
 * Omitting it lists the caller as the user, which is the only thing a non-mentor has.
 */
export function listSessions(params?: {
  as?: 'user' | 'mentor';
  limit?: number;
  cursor?: string;
}): Promise<Page<SessionView>> {
  const search = new URLSearchParams();
  if (params?.as) search.set('as', params.as);
  if (params?.limit) search.set('limit', String(params.limit));
  if (params?.cursor) search.set('cursor', params.cursor);
  const qs = search.toString();
  return apiGet<Page<SessionView>>(`/sessions${qs ? `?${qs}` : ''}`);
}

export function acceptSession(sessionId: string): Promise<StartSessionResult> {
  return apiPost<StartSessionResult>(`/sessions/${sessionId}/accept`, {});
}

export function declineSession(sessionId: string): Promise<SessionView> {
  return apiPost<SessionView>(`/sessions/${sessionId}/decline`, {});
}

export function cancelSession(sessionId: string): Promise<SessionView> {
  return apiPost<SessionView>(`/sessions/${sessionId}/cancel`, {});
}

export function endSession(sessionId: string): Promise<SessionView> {
  return apiPost<SessionView>(`/sessions/${sessionId}/end`, {});
}

export function refreshCredentials(sessionId: string): Promise<StartSessionResult> {
  return apiPost<StartSessionResult>(`/sessions/${sessionId}/credentials`, {});
}

export function recordConsent(sessionId: string): Promise<SessionView> {
  return apiPost<SessionView>(`/sessions/${sessionId}/consent`, {});
}

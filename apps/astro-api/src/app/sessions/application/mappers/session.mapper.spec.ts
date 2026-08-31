import type { ISessionRecord } from '../../domain/repos/session.repos';
import { billedSeconds, toSessionView } from './session.mapper';

const base: ISessionRecord = {
  id: 'ses_1',
  mode: 'VOICE',
  status: 'ACTIVE',
  userId: 'usr_1',
  userDisplayName: 'Ravi',
  mentorProfileId: 'mnt_1',
  mentorUserId: 'usr_2',
  mentorDisplayName: 'Asha',
  ratePaisePerMinute: 2000,
  platformFeeBps: 3000,
  createdAt: new Date('2026-08-10T10:00:00Z'),
  ringingAt: new Date('2026-08-10T10:00:00Z'),
  acceptedAt: new Date('2026-08-10T10:00:05Z'),
  billingAnchorAt: null,
  endedAt: null,
  endReason: null,
  livekitRoomName: 'session:ses_1',
  livekitRoomSid: 'RM_1',
  participantJoinCount: 0,
  connectedIdentities: [],
  recordingConsentUserAt: null,
  recordingConsentMentorAt: null,
  egressId: null,
  summaryIneligibleReason: null,
  lastMessageAt: null,
  messageCount: 0,
  messagesPurgedAt: null,
  rating: null,
};

describe('session mapper', () => {
  it('reports null duration before the anchor exists', () => {
    // Not 0: "the call has not started" and "the call started and lasted no time" are
    // different facts, and only one of them is billable.
    expect(billedSeconds(base, new Date('2026-08-10T10:05:00Z'))).toBeNull();
    expect(toSessionView(base).billedSeconds).toBeNull();
  });

  it('measures a live session against now', () => {
    const record = { ...base, billingAnchorAt: new Date('2026-08-10T10:00:10Z') };
    expect(billedSeconds(record, new Date('2026-08-10T10:03:10Z'))).toBe(180);
  });

  it('pins an ended session to endedAt, so the number stops moving', () => {
    const record: ISessionRecord = {
      ...base,
      status: 'COMPLETED',
      billingAnchorAt: new Date('2026-08-10T10:00:10Z'),
      endedAt: new Date('2026-08-10T10:02:10Z'),
      endReason: 'COMPLETED_BY_USER',
    };
    expect(billedSeconds(record, new Date('2026-08-10T23:00:00Z'))).toBe(120);
  });

  it('clamps a skewed anchor rather than showing a negative duration', () => {
    // `billingAnchorAt` for a voice call comes from LiveKit's clock, not ours.
    const record = { ...base, billingAnchorAt: new Date('2026-08-10T10:10:00Z') };
    expect(billedSeconds(record, new Date('2026-08-10T10:05:00Z'))).toBe(0);
  });

  it('exposes consent as booleans, never as the timestamps themselves', () => {
    const view = toSessionView({
      ...base,
      recordingConsentUserAt: new Date('2026-08-10T10:00:20Z'),
    });
    expect(view.recordingConsentUser).toBe(true);
    expect(view.recordingConsentMentor).toBe(false);
  });

  it('carries the FROZEN rate, not a live lookup', () => {
    // The whole point of the column: a mentor editing their rate mid-call must not change
    // what this session says it costs.
    expect(toSessionView(base).ratePaisePerMinute).toBe(2000);
  });
});

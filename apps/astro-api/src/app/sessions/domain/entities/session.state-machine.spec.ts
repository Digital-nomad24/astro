import { SESSION_END_REASONS, SESSION_STATUSES, type SessionStatus } from '@astro/contracts';
import { DomainError } from '@astro/errors';

import {
  SESSION_TRANSITIONS,
  TERMINAL_STATUSES,
  TERMINAL_STATUS_FOR_REASON,
  assertTransition,
  canTransition,
  isTerminal,
  terminalStatusFor,
} from './session.state-machine';

describe('session state machine', () => {
  it('covers every status declared in the contracts enum', () => {
    // The table and the enum are two declarations of the same set. A status added to the
    // contract but forgotten here would otherwise surface as `undefined.includes` at runtime,
    // in whichever transition happened to touch it first.
    expect(Object.keys(SESSION_TRANSITIONS).sort()).toEqual([...SESSION_STATUSES].sort());
  });

  it('maps every end reason to a terminal status', () => {
    expect(Object.keys(TERMINAL_STATUS_FOR_REASON).sort()).toEqual([...SESSION_END_REASONS].sort());
    for (const reason of SESSION_END_REASONS) {
      expect(TERMINAL_STATUSES).toContain(TERMINAL_STATUS_FOR_REASON[reason]);
    }
  });

  it('lets no terminal status transition anywhere', () => {
    for (const status of TERMINAL_STATUSES) {
      expect(SESSION_TRANSITIONS[status]).toEqual([]);
      for (const target of SESSION_STATUSES) {
        expect(canTransition(status, target)).toBe(false);
      }
    }
  });

  it('allows exactly the intended live transitions', () => {
    expect(canTransition('QUEUED', 'RINGING')).toBe(true);
    expect(canTransition('RINGING', 'ACTIVE')).toBe(true);
    expect(canTransition('ACTIVE', 'COMPLETED')).toBe(true);

    // The two that matter most: a call cannot skip the ring, and an active call cannot be
    // filed as if it never happened.
    expect(canTransition('QUEUED', 'ACTIVE')).toBe(false);
    expect(canTransition('ACTIVE', 'CANCELLED')).toBe(false);
    expect(canTransition('RINGING', 'QUEUED')).toBe(false);
  });

  it('throws a domain error, not a bare Error, on an illegal transition', () => {
    expect(() => assertTransition('COMPLETED', 'ACTIVE')).toThrow(DomainError);
    try {
      assertTransition('COMPLETED', 'ACTIVE');
    } catch (error) {
      expect((error as DomainError).code).toBe('INVALID_SESSION_TRANSITION');
      expect((error as DomainError).httpStatus).toBe(409);
    }
  });

  describe('terminalStatusFor', () => {
    it('files a call that never connected as CANCELLED', () => {
      expect(terminalStatusFor('RING_TIMEOUT', 'RINGING')).toBe('CANCELLED');
      expect(terminalStatusFor('DECLINED', 'RINGING')).toBe('CANCELLED');
      expect(terminalStatusFor('CANCELLED_BY_USER', 'QUEUED')).toBe('CANCELLED');
    });

    it('refuses to cancel a session that reached ACTIVE', () => {
      // CANCELLED means "never happened". A call that was ACTIVE demonstrably did, and filing
      // it as cancelled would hide billable time from M10's reconciliation.
      expect(terminalStatusFor('CANCELLED_BY_USER', 'ACTIVE')).toBe('COMPLETED');
      expect(terminalStatusFor('MENTOR_OFFLINE', 'ACTIVE')).toBe('COMPLETED');
    });

    it('files a balance cutoff as COMPLETED, not FAILED', () => {
      // A call that ran out of money ran to completion from the user's side. Filing it as a
      // failure would make the healthiest signal in the product look like an incident.
      expect(terminalStatusFor('BALANCE_EXHAUSTED', 'ACTIVE')).toBe('COMPLETED');
      expect(terminalStatusFor('MAX_DURATION_REACHED', 'ACTIVE')).toBe('COMPLETED');
    });

    it('keeps media failure as FAILED from any state', () => {
      expect(terminalStatusFor('MEDIA_FAILURE', 'RINGING')).toBe('FAILED');
      expect(terminalStatusFor('MEDIA_FAILURE', 'ACTIVE')).toBe('FAILED');
    });

    it('always produces a status that is actually terminal', () => {
      for (const reason of SESSION_END_REASONS) {
        for (const from of SESSION_STATUSES as readonly SessionStatus[]) {
          expect(isTerminal(terminalStatusFor(reason, from))).toBe(true);
        }
      }
    });
  });
});

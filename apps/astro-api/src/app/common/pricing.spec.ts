import {
  NOT_STARTED,
  affordableIntervals,
  billingIntervalIndex,
  feeSplit,
  intervalsDue,
  maxAffordableSeconds,
  ratePerInterval,
} from '@astro/pricing';

/**
 * The billing arithmetic, exercised from the app so this also proves the workspace lib
 * resolves at test time (`@astro/pricing` → `libs/.../pricing/dist`).
 *
 * The ledger tests that need a real Postgres arrive in M9; these are the pure half, and they
 * are the half that decides how much money moves.
 */
describe('@astro/pricing', () => {
  const MINUTE = 60;
  const anchor = 1_700_000_000_000;

  describe('billingIntervalIndex', () => {
    it('charges index 0 the moment the session anchors (prepaid)', () => {
      expect(billingIntervalIndex(anchor, anchor, MINUTE)).toBe(0);
    });

    it('advances on the interval boundary, not before', () => {
      expect(billingIntervalIndex(anchor, anchor + 59_999, MINUTE)).toBe(0);
      expect(billingIntervalIndex(anchor, anchor + 60_000, MINUTE)).toBe(1);
      expect(billingIntervalIndex(anchor, anchor + 185_000, MINUTE)).toBe(3);
    });

    it('reports NOT_STARTED before the anchor rather than a negative charge', () => {
      expect(billingIntervalIndex(anchor, anchor - 1, MINUTE)).toBe(NOT_STARTED);
    });
  });

  describe('intervalsDue', () => {
    const due = (over: Partial<Parameters<typeof intervalsDue>[0]>) =>
      intervalsDue({
        anchorAtMs: anchor,
        atMs: anchor,
        intervalSeconds: MINUTE,
        lastBilledIndex: -1,
        maxPerTick: 10,
        ...over,
      });

    it('charges the first interval immediately', () => {
      expect(due({})).toEqual([0]);
    });

    it('is a no-op when the current interval is already billed', () => {
      expect(due({ atMs: anchor + 30_000, lastBilledIndex: 0 })).toEqual([]);
    });

    it('catches up every interval a stalled sweeper missed', () => {
      // Instance restarted mid-call: nothing billed, five minutes elapsed.
      expect(due({ atMs: anchor + 5 * 60_000 })).toEqual([0, 1, 2, 3, 4, 5]);
    });

    it('caps the catch-up burst so a stalled session cannot drain a wallet at once', () => {
      expect(due({ atMs: anchor + 60 * 60_000, maxPerTick: 3 })).toEqual([0, 1, 2]);
    });

    it('returns nothing before the anchor', () => {
      expect(due({ atMs: anchor - 1000 })).toEqual([]);
    });
  });

  describe('affordability', () => {
    it('never divides by a zero rate — that is a call that can never be cut off', () => {
      expect(affordableIntervals(100_000, 0)).toBe(0);
      expect(affordableIntervals(100_000, -5)).toBe(0);
      expect(
        maxAffordableSeconds({
          balancePaise: 100_000,
          ratePaisePerInterval: 0,
          intervalSeconds: MINUTE,
        }),
      ).toBe(0);
    });

    it('floors to whole prepaid intervals', () => {
      // Rs 60 at Rs 20/min -> exactly 3 minutes.
      expect(
        maxAffordableSeconds({
          balancePaise: 6000,
          ratePaisePerInterval: 2000,
          intervalSeconds: MINUTE,
        }),
      ).toBe(180);
      // One paise short of the 4th minute buys no part of it.
      expect(
        maxAffordableSeconds({
          balancePaise: 7999,
          ratePaisePerInterval: 2000,
          intervalSeconds: MINUTE,
        }),
      ).toBe(180);
    });

    it('treats a zero or negative balance as unaffordable', () => {
      expect(affordableIntervals(0, 2000)).toBe(0);
      expect(affordableIntervals(-1, 2000)).toBe(0);
    });
  });

  describe('ratePerInterval', () => {
    it('is the per-minute rate when the interval is a minute', () => {
      expect(ratePerInterval(2000, 60)).toBe(2000);
    });

    it('scales to sub-minute intervals', () => {
      expect(ratePerInterval(2000, 30)).toBe(1000);
      expect(ratePerInterval(2000, 1)).toBe(33);
    });
  });

  describe('feeSplit', () => {
    it('splits at the configured commission', () => {
      expect(feeSplit(2000, 3000)).toEqual({
        grossPaise: 2000,
        platformFeePaise: 600,
        netPaise: 1400,
        platformFeeBps: 3000,
      });
    });

    it('handles the boundaries', () => {
      expect(feeSplit(2000, 0)).toMatchObject({ platformFeePaise: 0, netPaise: 2000 });
      expect(feeSplit(2000, 10_000)).toMatchObject({ platformFeePaise: 2000, netPaise: 0 });
      expect(feeSplit(0, 3000)).toMatchObject({ platformFeePaise: 0, netPaise: 0 });
    });

    it('keeps fee + net === gross for every input (the ledger invariant)', () => {
      for (let gross = 0; gross <= 5000; gross += 7) {
        for (const bps of [0, 1, 250, 3000, 3333, 9999, 10_000]) {
          const split = feeSplit(gross, bps);
          expect(split.platformFeePaise + split.netPaise).toBe(gross);
          expect(Number.isInteger(split.platformFeePaise)).toBe(true);
          expect(Number.isInteger(split.netPaise)).toBe(true);
        }
      }
    });

    it('rejects inputs that would silently corrupt the ledger', () => {
      expect(() => feeSplit(10.5, 3000)).toThrow(RangeError);
      expect(() => feeSplit(-1, 3000)).toThrow(RangeError);
      expect(() => feeSplit(100, 10_001)).toThrow(RangeError);
      expect(() => feeSplit(100, -1)).toThrow(RangeError);
    });
  });
});

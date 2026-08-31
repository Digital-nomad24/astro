/**
 * Splitting a gross charge between the platform and the mentor.
 *
 * The invariant that matters: **`platformFeePaise + netPaise === grossPaise`, exactly, for
 * every input.** It holds by construction because only the fee is rounded and the net is the
 * remainder — rounding both independently is how ledgers end up one paise short in a way
 * nobody can explain months later.
 */

const BPS_DENOMINATOR = 10_000;

export interface FeeSplit {
  readonly grossPaise: number;
  readonly platformFeePaise: number;
  readonly netPaise: number;
  /** Frozen onto the earning row, so a later fee change never rewrites history. */
  readonly platformFeeBps: number;
}

export function feeSplit(grossPaise: number, platformFeeBps: number): FeeSplit {
  if (!Number.isInteger(grossPaise) || grossPaise < 0) {
    throw new RangeError(`grossPaise must be a non-negative integer, got ${grossPaise}`);
  }
  if (!Number.isInteger(platformFeeBps) || platformFeeBps < 0 || platformFeeBps > BPS_DENOMINATOR) {
    throw new RangeError(`platformFeeBps must be an integer in [0, ${BPS_DENOMINATOR}], got ${platformFeeBps}`);
  }

  const platformFeePaise = Math.round((grossPaise * platformFeeBps) / BPS_DENOMINATOR);
  return {
    grossPaise,
    platformFeePaise,
    netPaise: grossPaise - platformFeePaise, // remainder, never independently rounded
    platformFeeBps,
  };
}

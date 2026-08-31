/**
 * Money on the wire is always an integer count of the currency's minor unit — paise for INR.
 * Never a float, never a formatted string. Fields carrying money are suffixed `Paise` so a
 * rupee/paise mix-up is visible at the call site rather than in a ledger three weeks later.
 */
export type Paise = number;

export const DEFAULT_CURRENCY = 'INR' as const;
export type Currency = typeof DEFAULT_CURRENCY;

/** Basis points: 10000 = 100%. The platform commission is expressed in these. */
export type Bps = number;
export const BPS_DENOMINATOR = 10_000 as const;

import type { Paise } from '@astro/contracts';

/** Display integer paise as rupees (e.g. 50000 → "₹500"). */
export function formatPaise(paise: Paise): string {
  const rupees = paise / 100;
  if (Number.isInteger(rupees)) {
    return `₹${rupees.toLocaleString('en-IN')}`;
  }
  return `₹${rupees.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** Per-minute rate label. */
export function formatRatePerMinute(paisePerMinute: Paise): string {
  return `${formatPaise(paisePerMinute)}/min`;
}

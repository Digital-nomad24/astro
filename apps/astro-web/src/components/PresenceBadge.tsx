import type { PresenceState } from '@astro/contracts';

const LABELS: Record<PresenceState, string> = {
  ONLINE: 'Online',
  BUSY: 'In session',
  OFFLINE: 'Offline',
};

interface PresenceBadgeProps {
  state: PresenceState;
  accepting?: boolean;
  compact?: boolean;
}

export function PresenceBadge({ state, accepting = true, compact = false }: PresenceBadgeProps) {
  const label =
    state === 'ONLINE' && !accepting ? 'Not accepting' : LABELS[state];

  return (
    <span className={`presence-badge presence-${state.toLowerCase()}${compact ? ' compact' : ''}`}>
      <span className="presence-dot" aria-hidden />
      {label}
    </span>
  );
}

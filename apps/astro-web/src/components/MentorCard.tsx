import { Link } from 'react-router-dom';
import type { MentorPresenceSnapshot } from '@astro/contracts/sockets';

import type { MentorCardResponse } from '../types/api';
import { formatRatePerMinute } from '../lib/money';
import { PresenceBadge } from './PresenceBadge';

interface MentorCardProps {
  mentor: MentorCardResponse;
  presenceOverride?: MentorPresenceSnapshot;
}

function mergePresence(
  mentor: MentorCardResponse,
  override?: MentorPresenceSnapshot,
): Pick<MentorCardResponse, 'presenceState' | 'acceptingNewCalls' | 'queueDepth'> {
  if (!override || override.updatedAtMs === 0) {
    return mentor;
  }
  return {
    presenceState: override.state,
    acceptingNewCalls: override.acceptingNewCalls,
    queueDepth: override.queueDepth,
  };
}

export function MentorCard({ mentor, presenceOverride }: MentorCardProps) {
  const live = mergePresence(mentor, presenceOverride);

  return (
    <Link to={`/mentors/${mentor.id}`} className="mentor-card">
      <div className="mentor-card-top">
        <div>
          <h3>{mentor.displayName}</h3>
          {mentor.headline && <p className="headline">{mentor.headline}</p>}
        </div>
        <PresenceBadge state={live.presenceState} accepting={live.acceptingNewCalls} compact />
      </div>
      <div className="mentor-card-meta">
        <span>{mentor.categoryName}</span>
        <span>{formatRatePerMinute(mentor.ratePaisePerMinute)}</span>
      </div>
      <div className="mentor-card-stats">
        <span>★ {mentor.ratingAvg.toFixed(1)} ({mentor.ratingCount})</span>
        <span>{mentor.experienceYears} yrs</span>
        {live.queueDepth > 0 && <span>{live.queueDepth} in queue</span>}
      </div>
      <div className="mentor-card-langs">
        {mentor.languages.slice(0, 3).map((lang) => (
          <span key={lang} className="tag">
            {lang}
          </span>
        ))}
      </div>
    </Link>
  );
}

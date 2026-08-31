import { useCallback, useEffect, useState } from 'react';

import { PresenceBadge } from '../components/PresenceBadge';
import { apiGet, apiPost } from '../lib/api';
import { formatRatePerMinute } from '../lib/money';
import type { MyMentorProfileResponse, Page } from '../types/api';
import type { MentorApprovalStatus } from '@astro/contracts';

export function AdminPage() {
  const [applications, setApplications] = useState<MyMentorProfileResponse[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<MentorApprovalStatus | ''>('PENDING');
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [noteById, setNoteById] = useState<Record<string, string>>({});

  const loadApplications = useCallback(async (cursor?: string) => {
    const params = new URLSearchParams();
    if (statusFilter) params.set('status', statusFilter);
    params.set('limit', '20');
    if (cursor) params.set('cursor', cursor);

    const page = await apiGet<Page<MyMentorProfileResponse>>(
      `/admin/mentors?${params.toString()}`,
    );
    if (cursor) {
      setApplications((prev) => [...prev, ...page.items]);
    } else {
      setApplications(page.items);
    }
    setNextCursor(page.nextCursor);
  }, [statusFilter]);

  useEffect(() => {
    setLoading(true);
    void loadApplications()
      .catch((err) => setError(err instanceof Error ? err.message : 'Failed to load queue'))
      .finally(() => setLoading(false));
  }, [loadApplications]);

  async function handleReview(
    id: string,
    status: 'APPROVED' | 'REJECTED' | 'SUSPENDED',
  ) {
    setBusyId(id);
    setError(null);
    try {
      const note = noteById[id]?.trim();
      if (status !== 'APPROVED' && (!note || note.length < 3)) {
        setError('A note is required when rejecting or suspending.');
        return;
      }
      await apiPost<MyMentorProfileResponse>(`/admin/mentors/${id}/review`, {
        status,
        note: status === 'APPROVED' ? undefined : note,
      });
      setApplications((prev) => prev.filter((a) => a.id !== id));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Review failed');
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="admin-page">
      <header className="browse-header">
        <div>
          <h1>Admin — mentor review</h1>
          <p className="lead">Approve or reject mentor applications.</p>
        </div>
        <select
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value as MentorApprovalStatus | '')}
          aria-label="Filter by status"
        >
          <option value="PENDING">Pending</option>
          <option value="APPROVED">Approved</option>
          <option value="REJECTED">Rejected</option>
          <option value="SUSPENDED">Suspended</option>
        </select>
      </header>

      {error && <p className="error-banner">{error}</p>}

      {loading ? (
        <p className="muted center">Loading queue…</p>
      ) : applications.length === 0 ? (
        <p className="muted center">No applications in this queue.</p>
      ) : (
        <ul className="admin-list">
          {applications.map((app) => (
            <li key={app.id} className="admin-item">
              <div className="admin-item-main">
                <h3>{app.displayName}</h3>
                <p className="muted">{app.categoryName} · {formatRatePerMinute(app.ratePaisePerMinute)}</p>
                {app.headline && <p>{app.headline}</p>}
                {app.bio && <p className="bio-snippet">{app.bio.slice(0, 200)}{app.bio.length > 200 ? '…' : ''}</p>}
                <div className="tag-row">
                  {app.languages.map((l) => (
                    <span key={l} className="tag">{l}</span>
                  ))}
                </div>
                <PresenceBadge state={app.presenceState} accepting={app.acceptingNewCalls} compact />
              </div>
              <div className="admin-item-actions">
                <textarea
                  placeholder="Note (required for reject/suspend)"
                  value={noteById[app.id] ?? ''}
                  onChange={(e) =>
                    setNoteById((prev) => ({ ...prev, [app.id]: e.target.value }))
                  }
                  rows={2}
                />
                <div className="admin-btns">
                  <button
                    type="button"
                    className="btn primary"
                    disabled={busyId === app.id}
                    onClick={() => void handleReview(app.id, 'APPROVED')}
                  >
                    Approve
                  </button>
                  <button
                    type="button"
                    className="btn secondary"
                    disabled={busyId === app.id}
                    onClick={() => void handleReview(app.id, 'REJECTED')}
                  >
                    Reject
                  </button>
                  <button
                    type="button"
                    className="btn ghost"
                    disabled={busyId === app.id}
                    onClick={() => void handleReview(app.id, 'SUSPENDED')}
                  >
                    Suspend
                  </button>
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}

      {nextCursor && (
        <div className="load-more">
          <button
            type="button"
            className="btn secondary"
            onClick={() => void loadApplications(nextCursor)}
          >
            Load more
          </button>
        </div>
      )}
    </div>
  );
}

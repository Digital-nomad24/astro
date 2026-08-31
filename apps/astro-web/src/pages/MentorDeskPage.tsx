import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';

import { PresenceBadge } from '../components/PresenceBadge';
import { useAuth } from '../auth/AuthProvider';
import { apiGet, apiPatch } from '../lib/api';
import { formatRatePerMinute } from '../lib/money';
import {
  HEARTBEAT_INTERVAL_MS,
  connectPresence,
  mentorGoOffline,
  mentorGoOnline,
  mentorSetAccepting,
  presenceHeartbeat,
} from '../lib/socket';
import type { MyMentorProfileResponse } from '../types/api';

export function MentorDeskPage() {
  const { me, refreshMe } = useAuth();
  const [profile, setProfile] = useState<MyMentorProfileResponse | null>(null);
  const [online, setOnline] = useState(false);
  const [accepting, setAccepting] = useState(true);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [statusMsg, setStatusMsg] = useState<string | null>(null);
  const heartbeatRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const stopHeartbeat = useCallback(() => {
    if (heartbeatRef.current) {
      clearInterval(heartbeatRef.current);
      heartbeatRef.current = null;
    }
  }, []);

  const startHeartbeat = useCallback(() => {
    stopHeartbeat();
    heartbeatRef.current = setInterval(() => {
      void presenceHeartbeat().catch(() => {
        stopHeartbeat();
        setOnline(false);
      });
    }, HEARTBEAT_INTERVAL_MS);
  }, [stopHeartbeat]);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      setError(null);
      try {
        const p = await apiGet<MyMentorProfileResponse>('/mentors/me');
        if (cancelled) return;
        setProfile(p);
        setAccepting(p.acceptingNewCalls);
        setOnline(p.presenceState === 'ONLINE' || p.presenceState === 'BUSY');
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Could not load mentor profile');
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    void load();
    return () => {
      cancelled = true;
      stopHeartbeat();
    };
  }, [stopHeartbeat]);

  useEffect(() => {
    if (online && profile?.approvalStatus === 'APPROVED') {
      startHeartbeat();
    } else {
      stopHeartbeat();
    }
    return stopHeartbeat;
  }, [online, profile?.approvalStatus, startHeartbeat, stopHeartbeat]);

  async function handleGoOnline() {
    if (profile?.approvalStatus !== 'APPROVED') {
      setError('Your application must be approved before going online.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await connectPresence();
      await mentorGoOnline(accepting);
      setOnline(true);
      startHeartbeat();
      setStatusMsg('You are online. Heartbeat active.');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not go online');
    } finally {
      setBusy(false);
    }
  }

  async function handleGoOffline() {
    setBusy(true);
    setError(null);
    try {
      await mentorGoOffline();
      stopHeartbeat();
      setOnline(false);
      setStatusMsg('You are offline.');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not go offline');
    } finally {
      setBusy(false);
    }
  }

  async function handleToggleAccepting() {
    if (!online) return;
    setBusy(true);
    setError(null);
    try {
      const next = !accepting;
      await mentorSetAccepting(next);
      setAccepting(next);
      setStatusMsg(next ? 'Accepting new sessions.' : 'Online but not accepting new sessions.');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not update availability');
    } finally {
      setBusy(false);
    }
  }

  async function handleSaveProfile(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!profile) return;
    const form = new FormData(e.currentTarget);
    setBusy(true);
    setError(null);
    try {
      const updated = await apiPatch<MyMentorProfileResponse>('/mentors/me', {
        headline: (form.get('headline') as string) || null,
        bio: (form.get('bio') as string) || null,
      });
      setProfile(updated);
      await refreshMe();
      setStatusMsg('Profile saved.');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Save failed');
    } finally {
      setBusy(false);
    }
  }

  if (loading) {
    return <p className="muted center">Loading desk…</p>;
  }

  if (error && !profile) {
    return (
      <div className="narrow-page">
        <p className="error-banner">{error}</p>
        <p className="muted">
          You may need to <Link to="/apply">apply as a mentor</Link> first.
        </p>
      </div>
    );
  }

  if (!profile) return null;

  const canGoOnline = profile.approvalStatus === 'APPROVED';

  return (
    <div className="desk-page">
      <header className="desk-header">
        <div>
          <h1>Mentor desk</h1>
          <p className="lead">Control your availability. Stay connected while online.</p>
        </div>
        <PresenceBadge
          state={online ? (profile.presenceState === 'BUSY' ? 'BUSY' : 'ONLINE') : 'OFFLINE'}
          accepting={accepting}
        />
      </header>

      {error && <p className="error-banner">{error}</p>}
      {statusMsg && <p className="status-banner">{statusMsg}</p>}

      <section className="desk-panel">
        <h2>Availability</h2>
        <p className="muted">
          Status: <strong>{profile.approvalStatus}</strong>
          {!canGoOnline && profile.approvalNote && ` — ${profile.approvalNote}`}
        </p>
        <div className="desk-controls">
          {!online ? (
            <button
              type="button"
              className="btn primary"
              onClick={() => void handleGoOnline()}
              disabled={busy || !canGoOnline}
            >
              Go online
            </button>
          ) : (
            <>
              <button
                type="button"
                className="btn secondary"
                onClick={() => void handleGoOffline()}
                disabled={busy}
              >
                Go offline
              </button>
              <button
                type="button"
                className="btn ghost"
                onClick={() => void handleToggleAccepting()}
                disabled={busy}
              >
                {accepting ? 'Stop accepting' : 'Accept new sessions'}
              </button>
            </>
          )}
        </div>
        {!canGoOnline && (
          <p className="hint">
            {profile.approvalStatus === 'PENDING'
              ? 'Waiting for admin approval.'
              : 'Contact support if you believe this is an error.'}
          </p>
        )}
      </section>

      <section className="desk-panel">
        <h2>Your profile</h2>
        <dl className="detail-dl">
          <dt>Rate</dt>
          <dd>{formatRatePerMinute(profile.ratePaisePerMinute)}</dd>
          <dt>Category</dt>
          <dd>{profile.categoryName}</dd>
          <dt>Rating</dt>
          <dd>
            ★ {profile.ratingAvg.toFixed(1)} ({profile.ratingCount})
          </dd>
        </dl>
        <form className="stack-form" onSubmit={(e) => void handleSaveProfile(e)}>
          <label>
            Headline
            <input
              name="headline"
              type="text"
              defaultValue={profile.headline ?? ''}
              maxLength={140}
            />
          </label>
          <label>
            Bio
            <textarea name="bio" defaultValue={profile.bio ?? ''} maxLength={2000} rows={4} />
          </label>
          <button type="submit" className="btn secondary" disabled={busy}>
            Save profile
          </button>
        </form>
      </section>

      {me && (
        <p className="hint desk-footer">
          Signed in as {me.displayName} ({me.role})
        </p>
      )}
    </div>
  );
}

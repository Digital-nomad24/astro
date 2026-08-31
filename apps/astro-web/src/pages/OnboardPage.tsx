import { useState } from 'react';
import { useNavigate } from 'react-router-dom';

import { updateMe, useAuth } from '../auth/AuthProvider';
import { homePathForMe } from '../lib/roles';

export function OnboardPage() {
  const navigate = useNavigate();
  const { refreshMe } = useAuth();
  const [displayName, setDisplayName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await updateMe({ displayName: displayName.trim() });
      const me = await refreshMe();
      navigate(homePathForMe(me), { replace: true });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save profile');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="narrow-page">
      <h1>Welcome to Astro</h1>
      <p className="lead">Choose a display name so mentors know who they are talking to.</p>
      {error && <p className="error-banner">{error}</p>}
      <form className="stack-form" onSubmit={(e) => void handleSubmit(e)}>
        <label>
          Display name
          <input
            type="text"
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            minLength={2}
            maxLength={60}
            required
            placeholder="How you appear to mentors"
            autoFocus
          />
        </label>
        <button type="submit" className="btn primary" disabled={busy || displayName.trim().length < 2}>
          {busy ? 'Saving…' : 'Continue'}
        </button>
      </form>
    </div>
  );
}

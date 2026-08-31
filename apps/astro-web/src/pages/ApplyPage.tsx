import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';

import { useAuth } from '../auth/AuthProvider';
import { apiGet, apiPost } from '../lib/api';
import type {
  MentorCategoryResponse,
  MyMentorProfileResponse,
} from '../types/api';

export function ApplyPage() {
  const navigate = useNavigate();
  const { refreshMe } = useAuth();
  const [categories, setCategories] = useState<MentorCategoryResponse[]>([]);
  const [categorySlug, setCategorySlug] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [headline, setHeadline] = useState('');
  const [bio, setBio] = useState('');
  const [languages, setLanguages] = useState('');
  const [experienceYears, setExperienceYears] = useState<number | ''>('');
  const [ratePaisePerMinute, setRatePaisePerMinute] = useState<number | ''>('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void apiGet<MentorCategoryResponse[]>('/mentor-categories')
      .then((cats) => {
        setCategories(cats);
        if (cats[0]) setCategorySlug(cats[0].slug);
      })
      .catch((err) => setError(err instanceof Error ? err.message : 'Failed to load categories'))
      .finally(() => setLoading(false));
  }, []);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const langs = languages
        .split(',')
        .map((l) => l.trim())
        .filter(Boolean);
      await apiPost<MyMentorProfileResponse>('/mentors/apply', {
        categorySlug,
        displayName: displayName.trim(),
        headline: headline.trim() || undefined,
        bio: bio.trim() || undefined,
        languages: langs,
        experienceYears: Number(experienceYears),
        ratePaisePerMinute: Number(ratePaisePerMinute),
      });
      await refreshMe();
      navigate('/desk', { replace: true });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Application failed');
    } finally {
      setBusy(false);
    }
  }

  if (loading) {
    return <p className="muted center">Loading…</p>;
  }

  return (
    <div className="form-page">
      <h1>Become a mentor</h1>
      <p className="lead">
        Share your expertise. Applications are reviewed before you appear in the catalogue.
      </p>
      {error && <p className="error-banner">{error}</p>}
      <form className="stack-form wide" onSubmit={(e) => void handleSubmit(e)}>
        <label>
          Category
          <select value={categorySlug} onChange={(e) => setCategorySlug(e.target.value)} required>
            {categories.map((c) => (
              <option key={c.id} value={c.slug}>
                {c.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          Display name
          <input
            type="text"
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            minLength={2}
            maxLength={60}
            required
          />
        </label>
        <label>
          Headline
          <input
            type="text"
            value={headline}
            onChange={(e) => setHeadline(e.target.value)}
            maxLength={140}
            placeholder="One line about your expertise"
          />
        </label>
        <label>
          Bio
          <textarea
            value={bio}
            onChange={(e) => setBio(e.target.value)}
            maxLength={2000}
            rows={4}
            placeholder="Tell seekers what you help with"
          />
        </label>
        <label>
          Languages (comma-separated)
          <input
            type="text"
            value={languages}
            onChange={(e) => setLanguages(e.target.value)}
            required
          />
        </label>
        <label>
          Years of experience
          <input
            type="number"
            value={experienceYears}
            onChange={(e) =>
              setExperienceYears(e.target.value === '' ? '' : Number(e.target.value))
            }
            min={0}
            max={80}
            required
          />
        </label>
        <label>
          Rate (paise per minute)
          <input
            type="number"
            value={ratePaisePerMinute}
            onChange={(e) =>
              setRatePaisePerMinute(e.target.value === '' ? '' : Number(e.target.value))
            }
            min={1}
            step={100}
            required
          />
          <span className="hint">50000 paise = ₹500/min</span>
        </label>
        <div className="form-actions">
          <Link to="/browse" className="btn ghost">
            Cancel
          </Link>
          <button type="submit" className="btn primary" disabled={busy}>
            {busy ? 'Submitting…' : 'Submit application'}
          </button>
        </div>
      </form>
    </div>
  );
}

import { useCallback, useEffect, useState } from 'react';
import type { MentorPresenceSnapshot } from '@astro/contracts/sockets';
import type { MentorSort } from '@astro/contracts';

import { MentorCard } from '../components/MentorCard';
import { apiGet } from '../lib/api';
import { connectPresence, onPresenceChanged, subscribePresence } from '../lib/socket';
import type {
  MentorCardResponse,
  MentorCategoryResponse,
  Page,
} from '../types/api';

export function BrowsePage() {
  const [categories, setCategories] = useState<MentorCategoryResponse[]>([]);
  const [mentors, setMentors] = useState<MentorCardResponse[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [presenceMap, setPresenceMap] = useState<Map<string, MentorPresenceSnapshot>>(
    () => new Map(),
  );
  const [categorySlug, setCategorySlug] = useState('');
  const [onlineOnly, setOnlineOnly] = useState(false);
  const [sort, setSort] = useState<MentorSort>('RATING');
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadMentors = useCallback(
    async (cursor?: string) => {
      const params = new URLSearchParams();
      if (categorySlug) params.set('categorySlug', categorySlug);
      if (onlineOnly) params.set('onlineOnly', 'true');
      if (search.trim()) params.set('search', search.trim());
      params.set('sort', sort);
      params.set('limit', '20');
      if (cursor) params.set('cursor', cursor);

      const page = await apiGet<Page<MentorCardResponse>>(`/mentors?${params.toString()}`);
      if (cursor) {
        setMentors((prev) => [...prev, ...page.items]);
      } else {
        setMentors(page.items);
      }
      setNextCursor(page.nextCursor);
      return page.items;
    },
    [categorySlug, onlineOnly, search, sort],
  );

  useEffect(() => {
    let cancelled = false;
    async function init() {
      setLoading(true);
      setError(null);
      try {
        const cats = await apiGet<MentorCategoryResponse[]>('/mentor-categories');
        if (cancelled) return;
        setCategories(cats);
        await loadMentors();
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Failed to load mentors');
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    void init();
    return () => {
      cancelled = true;
    };
  }, [loadMentors]);

  useEffect(() => {
    let unsub: (() => void) | undefined;
    let cancelled = false;

    async function wirePresence() {
      try {
        await connectPresence();
        const slugs = categorySlug ? [categorySlug] : categories.map((c) => c.slug);
        if (slugs.length === 0) return;

        const snapshot = await subscribePresence({ categorySlugs: slugs });
        if (cancelled) return;

        setPresenceMap((prev) => {
          const next = new Map(prev);
          for (const s of snapshot) {
            next.set(s.mentorProfileId, s);
          }
          return next;
        });

        unsub = onPresenceChanged((s) => {
          setPresenceMap((prev) => {
            const next = new Map(prev);
            const existing = prev.get(s.mentorProfileId);
            if (!existing || s.updatedAtMs >= existing.updatedAtMs) {
              next.set(s.mentorProfileId, s);
            }
            return next;
          });
        });
      } catch {
        /* presence is best-effort for browse */
      }
    }

    if (categories.length > 0 || categorySlug) {
      void wirePresence();
    }

    return () => {
      cancelled = true;
      unsub?.();
    };
  }, [categorySlug, categories]);

  async function handleLoadMore() {
    if (!nextCursor || loadingMore) return;
    setLoadingMore(true);
    try {
      await loadMentors(nextCursor);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load more');
    } finally {
      setLoadingMore(false);
    }
  }

  function handleSearchSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    void loadMentors()
      .catch((err) => setError(err instanceof Error ? err.message : 'Search failed'))
      .finally(() => setLoading(false));
  }

  return (
    <div className="browse-page">
      <header className="browse-header">
        <div>
          <h1>Find a mentor</h1>
          <p className="lead">Browse by category. Presence updates live.</p>
        </div>
      </header>

      <div className="filters-bar">
        <form className="search-form" onSubmit={handleSearchSubmit}>
          <input
            type="search"
            placeholder="Search mentors…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <button type="submit" className="btn secondary">
            Search
          </button>
        </form>
        <select
          value={categorySlug}
          onChange={(e) => setCategorySlug(e.target.value)}
          aria-label="Category"
        >
          <option value="">All categories</option>
          {categories.map((c) => (
            <option key={c.id} value={c.slug}>
              {c.name}
            </option>
          ))}
        </select>
        <select value={sort} onChange={(e) => setSort(e.target.value as MentorSort)} aria-label="Sort">
          <option value="RATING">Top rated</option>
          <option value="PRICE_ASC">Price: low to high</option>
          <option value="PRICE_DESC">Price: high to low</option>
          <option value="NEWEST">Newest</option>
        </select>
        <label className="checkbox-label">
          <input
            type="checkbox"
            checked={onlineOnly}
            onChange={(e) => setOnlineOnly(e.target.checked)}
          />
          Online only
        </label>
      </div>

      {error && <p className="error-banner">{error}</p>}

      {loading ? (
        <p className="muted center">Loading mentors…</p>
      ) : mentors.length === 0 ? (
        <p className="muted center">No mentors match your filters.</p>
      ) : (
        <>
          <div className="mentor-grid">
            {mentors.map((m) => (
              <MentorCard key={m.id} mentor={m} presenceOverride={presenceMap.get(m.id)} />
            ))}
          </div>
          {nextCursor && (
            <div className="load-more">
              <button
                type="button"
                className="btn secondary"
                onClick={() => void handleLoadMore()}
                disabled={loadingMore}
              >
                {loadingMore ? 'Loading…' : 'Load more'}
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}

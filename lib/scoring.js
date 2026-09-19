// Advarr — pure scoring / filtering / dedup pipeline (fully unit-testable).

export function clamp01(x) {
  return Math.max(0, Math.min(1, x));
}

/** raw TMDB list item + type → unified candidate */
export function normalizeCandidate(raw, mediaType) {
  if (!raw || typeof raw.id !== 'number') return null;
  const date = mediaType === 'tv' ? raw.first_air_date : raw.release_date;
  return {
    id: raw.id,
    mediaType,
    key: `${mediaType}:${raw.id}`,
    title: raw.title || raw.name || `tmdb:${raw.id}`,
    originalTitle: raw.original_title || raw.original_name || '',
    releaseDate: date || '',
    year: date ? Number(String(date).slice(0, 4)) : 0,
    posterPath: raw.poster_path || '',
    backdropPath: raw.backdrop_path || '',
    overview: raw.overview || '',
    voteAverage: Number(raw.vote_average || 0),
    voteCount: Number(raw.vote_count || 0),
    popularity: Number(raw.popularity || 0),
    originalLanguage: raw.original_language || '',
    genreIds: Array.isArray(raw.genre_ids) ? raw.genre_ids : (raw.genre_ids == null && Array.isArray(raw.genres) ? raw.genres.map((g) => g.id) : []),
    adult: Boolean(raw.adult),
    sources: new Set(),
  };
}

export function passesFilters(c, filters) {
  if (filters.includeAdult !== true && c.adult) return { ok: false, reason: 'adult' };
  if (c.voteCount < (filters.minVotes ?? 0)) return { ok: false, reason: 'votes' };
  if (c.voteAverage < (filters.minRating ?? 0)) return { ok: false, reason: 'rating' };

  if (filters.yearFrom > 0 && c.year && c.year < filters.yearFrom) return { ok: false, reason: 'year' };
  if (filters.yearTo > 0 && c.year && c.year > filters.yearTo) return { ok: false, reason: 'year' };

  if (Array.isArray(filters.languages) && filters.languages.length > 0) {
    if (!filters.languages.includes(c.originalLanguage)) return { ok: false, reason: 'language' };
  }
  // genre filters do not apply to candidates without genre data (e.g. TMDB daily export)
  if (!c.noGenres) {
    const inc = filters.includeGenres || [];
    if (inc.length > 0 && !inc.some((g) => c.genreIds.includes(g))) return { ok: false, reason: 'genre' };
    const exc = filters.excludeGenres || [];
    if (exc.some((g) => c.genreIds.includes(g))) return { ok: false, reason: 'genre-excluded' };
  }
  return { ok: true, reason: null };
}

export function freshnessScore(releaseDate, now = Date.now()) {
  if (!releaseDate) return 0.3;
  const t = Date.parse(releaseDate);
  if (Number.isNaN(t)) return 0.3;
  const days = Math.max(0, (now - t) / 86400e3);
  if (days < 90) return 1;
  if (days < 180) return 0.85;
  // decay to ~0 at 3 years
  return clamp01(1 - (days - 180) / (365 * 2.6));
}

export function scoreCandidate(c, scoring, { now = Date.now() } = {}) {
  const w = {
    wRating: scoring.wRating ?? 0.35,
    wPopularity: scoring.wPopularity ?? 0.25,
    wVotes: scoring.wVotes ?? 0.15,
    wFreshness: scoring.wFreshness ?? 0.15,
    wGenres: scoring.wGenres ?? 0.10,
  };
  const wsum = w.wRating + w.wPopularity + w.wVotes + w.wFreshness + w.wGenres || 1;

  let rating = clamp01(c.voteAverage / 10);
  // thin votes → shrink trust in the rating
  if (c.voteCount > 0 && c.voteCount < 1000) rating *= 0.6 + 0.4 * (Math.log10(1 + c.voteCount) / 3);

  const pop = clamp01(Math.log10(1 + c.popularity) / Math.log10(1 + 2000));
  const votes = clamp01(Math.log10(1 + c.voteCount) / Math.log10(1 + 10000));
  const fresh = freshnessScore(c.releaseDate, now);

  const fav = scoring.favoriteGenres || [];
  const overlap = fav.filter((g) => c.genreIds.includes(g)).length;
  const genreScore = fav.length ? clamp01(overlap / fav.length) : 0.5;

  const score =
    (w.wRating * rating + w.wPopularity * pop + w.wVotes * votes + w.wFreshness * fresh + w.wGenres * genreScore) / wsum;

  return clamp01(score);
}

export const scoreToDisplay = (x) => Math.round(clamp01(x) * 100);

/** remove dupes within pool + already known (history/seerr) */
export function dedupeCandidates(cands, knownKeys) {
  const seen = new Set();
  const fresh = [];
  const skipped = [];
  for (const c of cands) {
    if (knownKeys.has(c.key)) { skipped.push({ candidate: c, reason: 'already-known' }); continue; }
    if (seen.has(c.key)) continue;
    seen.add(c.key);
    fresh.push(c);
  }
  return { fresh, skipped };
}

/** rank: score desc, popularity desc, votes desc */
export function rank(cands) {
  return [...cands].sort((a, b) =>
    b.score - a.score || b.popularity - a.popularity || b.voteCount - a.voteCount);
}

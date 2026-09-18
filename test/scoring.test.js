// Advarr tests — lib/scoring.js: normalize / filter / score / dedupe / rank / display.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeCandidate, passesFilters, freshnessScore, scoreCandidate,
  dedupeCandidates, rank, scoreToDisplay,
} from '../lib/scoring.js';
import { movieRaw, tvRaw, daysAgo } from './helpers.js';

const NOW = Date.parse('2026-09-18T12:00:00Z');

test('normalizeCandidate maps every raw TMDB field (movie)', () => {
  const c = normalizeCandidate(movieRaw(550, {
    title: 'Fight Club', release_date: '1999-10-15', vote_average: 8.4, vote_count: 25000,
    popularity: 95.5, original_language: 'en', genre_ids: [18, 80],
    poster_path: '/fc.jpg', backdrop_path: '/fcb.jpg', overview: 'An insomniac office worker…',
  }), 'movie');
  assert.equal(c.key, 'movie:550');
  assert.equal(c.id, 550);
  assert.equal(c.mediaType, 'movie');
  assert.equal(c.title, 'Fight Club');
  assert.equal(c.originalTitle, 'Original Movie 550');
  assert.equal(c.releaseDate, '1999-10-15');
  assert.equal(c.year, 1999);
  assert.equal(c.posterPath, '/fc.jpg');
  assert.equal(c.backdropPath, '/fcb.jpg');
  assert.equal(c.overview, 'An insomniac office worker…');
  assert.equal(c.voteAverage, 8.4);
  assert.equal(c.voteCount, 25000);
  assert.equal(c.popularity, 95.5);
  assert.equal(c.originalLanguage, 'en');
  assert.deepEqual(c.genreIds, [18, 80]);
  assert.equal(c.adult, false);
  assert.ok(c.sources instanceof Set && c.sources.size === 0);
});

test('normalizeCandidate maps tv via first_air_date / name', () => {
  const c = normalizeCandidate(tvRaw(1396, { first_air_date: '2005-03-20', name: 'Prison Break' }), 'tv');
  assert.equal(c.key, 'tv:1396');
  assert.equal(c.releaseDate, '2005-03-20'); // ← first_air_date, not release_date
  assert.equal(c.year, 2005);
  assert.equal(c.title, 'Prison Break');
  assert.deepEqual(c.genreIds, [18]);
});

test('normalizeCandidate: genres fallback, missing date → year 0, null on bad input', () => {
  const c = normalizeCandidate({ id: 1, genres: [{ id: 28 }, { id: 12 }] }, 'movie');
  assert.deepEqual(c.genreIds, [28, 12]);
  const noDate = normalizeCandidate({ id: 5, name: 'Mystery' }, 'tv');
  assert.equal(noDate.releaseDate, '');
  assert.equal(noDate.year, 0);
  assert.deepEqual(noDate.genreIds, []);
  assert.equal(normalizeCandidate(null, 'movie'), null);
  assert.equal(normalizeCandidate(undefined, 'tv'), null);
  assert.equal(normalizeCandidate({}, 'movie'), null);
  assert.equal(normalizeCandidate({ id: '550' }, 'movie'), null); // id must be a number
});

// ---------- passesFilters ----------

const cand = (over = {}) => ({
  ...normalizeCandidate(movieRaw(1, {
    release_date: '2020-05-01', vote_average: 7.5, vote_count: 5000,
    popularity: 300, original_language: 'en', genre_ids: [28],
  }), 'movie'),
  ...over,
});

const FILTERS = {
  includeAdult: false, minVotes: 100, minRating: 6, yearFrom: 2015, yearTo: 0,
  languages: [], includeGenres: [], excludeGenres: [],
};

test('passesFilters: clean candidate passes; empty filters pass too', () => {
  assert.deepEqual(passesFilters(cand(), FILTERS), { ok: true, reason: null });
  assert.deepEqual(passesFilters(cand(), {}), { ok: true, reason: null });
});

test('passesFilters: votes / rating thresholds', () => {
  assert.equal(passesFilters(cand({ voteCount: 50 }), FILTERS).reason, 'votes');
  assert.equal(passesFilters(cand({ voteCount: 100 }), FILTERS).ok, true); // boundary is <
  assert.equal(passesFilters(cand({ voteAverage: 5.5 }), FILTERS).reason, 'rating');
  assert.equal(passesFilters(cand({ voteAverage: 6 }), FILTERS).ok, true);
});

test('passesFilters: year window (from/to), yearTo=0 disables the ceiling', () => {
  assert.equal(passesFilters(cand({ year: 2010 }), { ...FILTERS, yearFrom: 2015 }).reason, 'year');
  assert.equal(passesFilters(cand({ year: 2024 }), { ...FILTERS, yearTo: 2020 }).reason, 'year');
  assert.equal(passesFilters(cand({ year: 2035 }), { ...FILTERS, yearTo: 0 }).ok, true); // 0 = no limit
  assert.equal(passesFilters(cand({ year: 0 }), { ...FILTERS, yearFrom: 2015 }).ok, true); // unknown year not punished
});

test('passesFilters: language whitelist / empty = any', () => {
  assert.equal(passesFilters(cand({ originalLanguage: 'ko' }), { ...FILTERS, languages: ['en', 'ru'] }).reason, 'language');
  assert.equal(passesFilters(cand({ originalLanguage: 'ko' }), { ...FILTERS, languages: [] }).ok, true);
});

test('passesFilters: genres include + exclude', () => {
  assert.equal(passesFilters(cand({ genreIds: [18] }), { ...FILTERS, includeGenres: [878] }).reason, 'genre');
  assert.equal(passesFilters(cand({ genreIds: [28, 18] }), { ...FILTERS, includeGenres: [878, 28] }).ok, true);
  assert.equal(passesFilters(cand({ genreIds: [28] }), { ...FILTERS, excludeGenres: [28] }).reason, 'genre-excluded');
  assert.equal(passesFilters(cand({ genreIds: [18] }), { ...FILTERS, excludeGenres: [28] }).ok, true);
});

test('passesFilters: adult gate (off by default, opt-in passes)', () => {
  assert.equal(passesFilters(cand({ adult: true }), FILTERS).reason, 'adult');
  assert.equal(passesFilters(cand({ adult: true }), { ...FILTERS, includeAdult: true }).ok, true);
});

// ---------- freshnessScore ----------

test('freshnessScore: fresh (<90d) = 1', () => {
  assert.equal(freshnessScore(daysAgo(10), NOW), 1);
  assert.equal(freshnessScore(daysAgo(89), NOW), 1);
});

test('freshnessScore: 90–180d plateau at 0.85', () => {
  assert.equal(freshnessScore(daysAgo(90), NOW), 0.85);
  assert.equal(freshnessScore(daysAgo(179), NOW), 0.85);
});

test('freshnessScore: linear decay after 180d → 0 at ~3y', () => {
  const y1 = freshnessScore(daysAgo(365), NOW);
  assert.ok(y1 > 0.7 && y1 < 0.85, `1y decay = ${y1}`);
  assert.equal(freshnessScore(daysAgo(5 * 365), NOW), 0); // clamped at zero
  assert.equal(freshnessScore('2027-01-01', NOW), 1); // future date → days clamped ≥ 0
});

test('freshnessScore: missing / unparseable date → 0.3', () => {
  assert.equal(freshnessScore('', NOW), 0.3);
  assert.equal(freshnessScore(null, NOW), 0.3);
  assert.equal(freshnessScore('not-a-date', NOW), 0.3);
});

// ---------- scoreCandidate ----------

const scored = (over = {}, scoring = {}, opts = {}) =>
  scoreCandidate(cand(over), scoring, { now: NOW, ...opts });

test('scoreCandidate: bounded 0..1', () => {
  const best = scored({ voteAverage: 10, voteCount: 1e7, popularity: 1e7, releaseDate: daysAgo(1) }, { favoriteGenres: [28] });
  const junk = scored({ voteAverage: 0, voteCount: 0, popularity: 0, releaseDate: '' });
  assert.ok(best > 0 && best <= 1, `best=${best}`);
  assert.ok(junk >= 0 && junk < 1, `junk=${junk}`);
  assert.equal(scoreToDisplay(best), 100);
});

test('scoreCandidate: equal weights → quality ordering (better item scores higher)', () => {
  const equalW = { wRating: 0.2, wPopularity: 0.2, wVotes: 0.2, wFreshness: 0.2, wGenres: 0.2, favoriteGenres: [] };
  const good = scored({ voteAverage: 9, voteCount: 20000, popularity: 1000, releaseDate: daysAgo(2) }, equalW);
  const bad = scored({ voteAverage: 5, voteCount: 120, popularity: 1, releaseDate: daysAgo(1500) }, equalW);
  assert.ok(good > bad, `good=${good} bad=${bad}`);
});

test('scoreCandidate: weight sum is normalized (doubled weights → same score)', () => {
  const over = { voteAverage: 8, voteCount: 5000, popularity: 500, releaseDate: daysAgo(30) };
  const single = scored(over, { wRating: 0.35, wPopularity: 0.25, wVotes: 0.15, wFreshness: 0.15, wGenres: 0.10 });
  const doubled = scored(over, { wRating: 0.70, wPopularity: 0.50, wVotes: 0.30, wFreshness: 0.30, wGenres: 0.20 });
  assert.ok(Math.abs(single - doubled) < 1e-9, `${single} vs ${doubled}`);
});

test('scoreCandidate: favoriteGenres boost', () => {
  const plain = scored({ genreIds: [28] }, { favoriteGenres: [] });
  const boosted = scored({ genreIds: [28] }, { favoriteGenres: [28] });
  assert.ok(boosted > plain, `boosted=${boosted} plain=${plain}`);
  const partial = scored({ genreIds: [28, 12] }, { favoriteGenres: [28, 878] }); // 1/2 overlap
  const full = scored({ genreIds: [28, 12] }, { favoriteGenres: [28, 12] });   // 2/2 overlap
  assert.ok(full > partial, `full=${full} partial=${partial}`);
});

test('scoreCandidate: thin-vote penalty shrinks trust in high rating', () => {
  const ratingOnly = { wRating: 1, wPopularity: 0, wVotes: 0, wFreshness: 0, wGenres: 0 };
  const trusted = scored({ voteAverage: 9.9, voteCount: 20000 }, ratingOnly);
  const thin = scored({ voteAverage: 9.9, voteCount: 100 }, ratingOnly);
  assert.ok(thin < trusted, `thin=${thin} trusted=${trusted}`);
  assert.ok(thin < 0.9, `thin (100 votes) = ${thin}`);
  const justEnough = scored({ voteAverage: 9.9, voteCount: 1000 }, ratingOnly);
  assert.ok(justEnough > thin); // penalty fades towards 1000 votes
});

// ---------- dedupeCandidates ----------

test('dedupeCandidates: drops known keys with reason, collapses intra-pool dupes', () => {
  const a = { key: 'movie:1' }, b = { key: 'movie:2' }, c = { key: 'movie:1' }, d = { key: 'tv:5' }, e = { key: 'tv:5' };
  const { fresh, skipped } = dedupeCandidates([a, b, c, d, e], new Set(['movie:2']));
  assert.deepEqual(fresh, [a, d]);           // first occurrences kept, intra-pool dupes silently dropped
  assert.equal(skipped.length, 1);
  assert.equal(skipped[0].reason, 'already-known');
  assert.equal(skipped[0].candidate, b);
  const again = dedupeCandidates([a, c], new Set());
  assert.deepEqual(again.fresh, [a]);        // known set empty → only pool dedupe applies
  assert.deepEqual(again.skipped, []);
});

// ---------- rank ----------

test('rank: score desc, popularity tiebreak, votes tiebreak; input untouched', () => {
  const mk = (score, popularity, voteCount) => ({ score, popularity, voteCount });
  const input = [mk(0.5, 900, 100), mk(0.9, 10, 10), mk(0.5, 900, 500), mk(0.7, 0, 0)];
  const ranked = rank(input);
  assert.deepEqual(ranked.map((c) => c.score), [0.9, 0.7, 0.5, 0.5]);
  assert.deepEqual(ranked.map((c) => [c.popularity, c.voteCount]), [[10, 10], [0, 0], [900, 500], [900, 100]]);
  assert.deepEqual(input.map((c) => c.score), [0.5, 0.9, 0.5, 0.7]); // original array untouched
});

// ---------- scoreToDisplay ----------

test('scoreToDisplay: clamp01 then ×100, rounded', () => {
  assert.equal(scoreToDisplay(0), 0);
  assert.equal(scoreToDisplay(1), 100);
  assert.equal(scoreToDisplay(0.123), 12);
  assert.equal(scoreToDisplay(-0.5), 0);
  assert.equal(scoreToDisplay(1.5), 100);
  assert.equal(scoreToDisplay(0.9999), 100);
});

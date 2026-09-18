# Advarr API v1 (internal contract)

Base: `/api/v1`. All JSON. Auth (if enabled via env `BASIC_AUTH_USER`/`BASIC_AUTH_PASS` or `ADVARR_API_KEY`): Basic auth or `X-Api-Key` header / `?apikey=`.

## GET /api/v1/status
```json
{
  "version": "0.1.0",
  "running": false,
  "nextRunAt": 1730000000000,
  "tmdb": { "connected": true, "language": "ru-RU" },
  "seerr": { "connected": true, "ok": true, "version": "2.7.3", "app": "jellyseerr" },
  "lastRun": { "startedAt": "...", "finishedAt": "...", "dry": false, "scanned": 180, "passed": 42, "skipped": 130, "requested": 5, "failed": 0, "errors": [], "titles": ["🎬 Movie A"] },
  "historyCount": 57
}
```
`tmdb.connected`/`seerr.connected` are `null|false|true` (null = not configured).

## GET /api/v1/settings → full config (secrets masked as `••••1234`)
## PUT /api/v1/settings ← partial deep-merge patch (masked values are ignored)
Config shape:
```json
{
  "tmdb": { "apiKey": "…", "language": "ru-RU", "region": "RU" },
  "seerr": { "url": "http://host:5055", "apiKey": "…", "tvSeasons": "all" },
  "schedule": { "enabled": true, "intervalHours": 12, "jitterMinutes": 30, "runOnStart": false },
  "selection": { "mediaTypes": ["movie","tv"], "moviesPerRun": 3, "showsPerRun": 2 },
  "filters": {
    "includeAdult": false, "minVotes": 200, "minRating": 6.5,
    "yearFrom": 2015, "yearTo": 0,
    "languages": [], "includeGenres": [], "excludeGenres": [],
    "excludeInSeerr": true, "checkAvailability": true
  },
  "sources": {
    "pages": 2, "perPage": 40,
    "trending_day": { "on": true, "weight": 1.0 },
    "trending_week": { "on": true, "weight": 1.0 },
    "popular": { "on": true, "weight": 0.9 },
    "top_rated": { "on": false, "weight": 0.7 },
    "now_playing": { "on": false, "weight": 0.8 },
    "upcoming": { "on": false, "weight": 0.8 },
    "discover": { "on": false, "weight": 0.6, "params": "" }
  },
  "scoring": { "wRating":0.35, "wPopularity":0.25, "wVotes":0.15, "wFreshness":0.15, "wGenres":0.10, "favoriteGenres": [] },
  "ui": { "pageSize": 24 }
}
```

## POST /api/v1/settings/test-tmdb  body: {apiKey?, language?, region?} → {ok, message}
## POST /api/v1/settings/test-seerr body: {url?, apiKey?} → {ok, message}
## GET /api/v1/genres/:type (movie|tv) → {type, genres:[{id,name}]}
## GET /api/v1/discover/preview?limit=24 → {report} (dry run; report.items = ranked candidates)
Candidate item:
```json
{ "id": 934433, "mediaType": "movie", "key": "movie:934433", "title": "Scream VI", "year": 2023,
  "releaseDate": "2023-03-08", "posterPath": "/abc.jpg", "overview": "…", "voteAverage": 7.1,
  "voteCount": 3200, "popularity": 850, "originalLanguage": "en", "genreIds": [27,9648],
  "sources": ["trending_week","popular"], "score": 72, "status": "dry" }
```
## POST /api/v1/run body {dry?:bool} → dry: {report}; else 202 {started:true} (poll /status)
## GET /api/v1/runs/last → {run|null}
## GET /api/v1/history?limit=100&offset=0&mediaType=&search= → {total, items:[historyEntry]}
historyEntry: {id, at, tmdbId, mediaType, title, year, posterPath, score, sources, status(requested|failed), error}
## DELETE /api/v1/history/:id → {ok} (forget → allows re-request)
## POST /api/v1/request body {mediaType, tmdbId, title?, year?, posterPath?} → {ok}|502
## GET /api/v1/logs?since=0&level=all → {entries:[{id,t,level,msg,extra?}]}
## GET /img/poster?path=/abc.jpg&size=w342 → image (proxy TMDB, sizes w92…original)
## GET /api/v1/health → {ok:true, uptime, version}

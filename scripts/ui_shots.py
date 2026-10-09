#!/usr/bin/env python3
"""Advarr UI screenshots bot — captures every README view deterministically.

Portable (repo-relative), no external network (scripts/ui_stubs.mjs stubs
TMDB + posters), seeds history/last-run for lively views. Fails the run on
JS page errors → doubles as a UI smoke gate. Used by .github/workflows/screenshots.yml.
"""
import json, os, subprocess, sys, tempfile, time, urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SHOTS = ROOT / "docs" / "screenshots"
PORT = int(os.environ.get("ADVARR_SHOTS_PORT", "8794"))
BASE = f"http://127.0.0.1:{PORT}"

SHOTS.mkdir(parents=True, exist_ok=True)
DATA = Path(tempfile.mkdtemp(prefix="advarr-shots-"))

# seed history (history view + historyCount on overview)
seed_history = {"items": [
  {"id": "s1", "at": "2026-09-18T08:12:00Z", "tmdbId": 693134, "mediaType": "movie", "title": "Дюна: Часть вторая", "year": 2024, "posterPath": "", "score": 92, "sources": ["trending_week", "top_rated"], "status": "requested", "error": None},
  {"id": "s2", "at": "2026-09-18T08:12:05Z", "tmdbId": 872906, "mediaType": "movie", "title": "Оппенгеймер", "year": 2023, "posterPath": "", "score": 87, "sources": ["top_rated"], "status": "requested", "error": None},
  {"id": "s3", "at": "2026-09-18T08:12:10Z", "tmdbId": 237941, "mediaType": "tv", "title": "Падение сокола", "year": 2024, "posterPath": "", "score": 74, "sources": ["trending_day"], "status": "failed", "error": "Seerr 500: radarr unavailable"},
  {"id": "s4", "at": "2026-09-17T21:40:00Z", "tmdbId": 119051, "mediaType": "tv", "title": "Уэнсдей", "year": 2022, "posterPath": "", "score": 81, "sources": ["popular"], "status": "requested", "error": None},
  {"id": "s5", "at": "2026-09-17T21:40:05Z", "tmdbId": 94605, "mediaType": "tv", "title": "Аркейн", "year": 2021, "posterPath": "", "score": 79, "sources": ["trending_week"], "status": "skipped", "error": None},
]}
json.dump(seed_history, open(DATA / "history.json", "w"))
# seed last run (overview + discovery «последний прогон» until a real run happens)
seed_runs = {"runs": [{
  "startedAt": "2026-09-18T08:12:00Z", "finishedAt": "2026-09-18T08:12:14Z", "dry": False,
  "scanned": 262, "passed": 37, "skipped": 225, "requested": 3, "failed": 1, "errors": [],
  "titles": ["Фильм: Дюна: Часть вторая", "Сериал: Уэнсдей", "Фильм: Кунг-фу Панда 4"],
}]}
json.dump(seed_runs, open(DATA / "runs.json", "w"))

proc = subprocess.Popen(
    ["node", "server.js"], cwd=ROOT,
    env={**os.environ,
         "ADVARR_DATA_DIR": str(DATA), "ADVARR_PORT": str(PORT),
         "TMDB_API_KEY": "stub-tmdb-key", "ADVARR_UI_STUBS": "1",
         "NODE_OPTIONS": "--import ./scripts/ui_stubs.mjs"},
    stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
try:
    for _ in range(30):
        try:
            urllib.request.urlopen(f"{BASE}/api/v1/health", timeout=1)
            break
        except Exception:
            time.sleep(0.4)

    # post-stub sanity: poster proxy must stream a generated image (catches broken /img/poster)
    with urllib.request.urlopen(f"{BASE}/img/poster?path=/p693134.jpg&size=w92", timeout=15) as r:
        if r.status != 200 or not r.read(8).startswith(b"\x89PNG"):
            print("FAIL — poster proxy did not return a PNG image", file=sys.stderr)
            sys.exit(1)
        print("poster proxy: ok")

    from playwright.sync_api import sync_playwright
    page_errors = []
    with sync_playwright() as p:
        b = p.chromium.launch()
        pg = b.new_page(viewport={"width": 1440, "height": 900})
        pg.on("pageerror", lambda e: page_errors.append(f"pageerror: {e}"))

        def shot(name, route, wait=1400):
            pg.goto(f"{BASE}/{route}")
            pg.wait_for_timeout(wait)
            pg.screenshot(path=SHOTS / f"{name}.png")
            print(f"captured {name}.png")

        # main views
        shot("overview", "#/overview")
        shot("discovery", "#/discovery", wait=3000)   # dry-run preview + stub TMDB
        shot("history", "#/history")
        shot("logs", "#/logs")

        # settings tabs (Radarr order: seerr, integrations, tmdb, ..., notify, backups, general)
        pg.goto(f"{BASE}/#/settings")
        pg.wait_for_timeout(1100)
        for tab in ["integrations", "notify", "backups", "sources", "general"]:
            pg.click(f'button[data-tab="{tab}"]')
            pg.wait_for_timeout(600)
            pg.screenshot(path=SHOTS / f"settings-{tab}.png")
            print(f"captured settings-{tab}.png")

        # mobile responsive
        m = b.new_page(viewport={"width": 420, "height": 860})
        m.on("pageerror", lambda e: page_errors.append(f"pageerror(mobile): {e}"))
        m.goto(f"{BASE}/#/overview")
        m.wait_for_timeout(1400)
        m.screenshot(path=SHOTS / "overview-mobile.png")
        print("captured overview-mobile.png")
        b.close()
finally:
    proc.terminate()

if page_errors:
    print(f"FAIL — {len(page_errors)} JS page error(s):", file=sys.stderr)
    for e in page_errors[:10]:
        print(" ", e, file=sys.stderr)
    sys.exit(1)
print("UI screenshots: all views captured, no JS errors")
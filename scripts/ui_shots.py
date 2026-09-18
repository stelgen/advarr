#!/usr/bin/env python3
"""UI smoke: screenshot all views + capture console/page errors."""
import json, os, subprocess, sys, time, urllib.request

ROOT = "/home/user/advarr"
DATA = "/tmp/advarr-shots"
PORT = 8794
os.makedirs(f"{ROOT}/docs/screenshots", exist_ok=True)
os.makedirs(f"{DATA}", exist_ok=True)

# seed history for a lively history view
seed = {"items": [
  {"id": "s1", "at": "2026-09-18T08:12:00Z", "tmdbId": 1011985, "mediaType": "movie", "title": "Кунг-фу Панда 4", "year": 2024, "posterPath": "", "score": 81, "sources": ["trending_week", "popular"], "status": "requested", "error": None},
  {"id": "s2", "at": "2026-09-18T08:12:05Z", "tmdbId": 872906, "mediaType": "movie", "title": "Oppenheimer", "year": 2023, "posterPath": "", "score": 74, "sources": ["top_rated"], "status": "requested", "error": None},
  {"id": "s3", "at": "2026-09-18T08:12:10Z", "tmdbId": 237941, "mediaType": "tv", "title": "Падение сокола", "year": 2024, "posterPath": "", "score": 66, "sources": ["trending_day"], "status": "failed", "error": "Seerr 500: radarr unavailable"},
  {"id": "s4", "at": "2026-09-17T21:40:00Z", "tmdbId": 119051, "mediaType": "tv", "title": "Уэнсдей", "year": 2022, "posterPath": "", "score": 71, "sources": ["popular"], "status": "requested", "error": None},
]}
json.dump(seed, open(f"{DATA}/history.json", "w"))

proc = subprocess.Popen(
    ["node", "server.js"], cwd=ROOT,
    env={**os.environ, "ADVARR_DATA_DIR": DATA, "ADVARR_PORT": str(PORT)},
    stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
for _ in range(30):
    try:
        urllib.request.urlopen(f"http://127.0.0.1:{PORT}/api/v1/health", timeout=1)
        break
    except Exception:
        time.sleep(0.4)

from playwright.sync_api import sync_playwright
errors = []
with sync_playwright() as p:
    b = p.chromium.launch()
    pg = b.new_page(viewport={"width": 1440, "height": 900})
    pg.on("pageerror", lambda e: errors.append(f"pageerror: {e}"))
    pg.on("console", lambda m: errors.append(f"console.{m.type}: {m.text}") if m.type == "error" else None)

    for name, route in [("overview", "#/overview"), ("discovery", "#/discovery"),
                        ("history", "#/history"), ("settings", "#/settings"), ("logs", "#/logs")]:
        pg.goto(f"http://127.0.0.1:{PORT}/{route}")
        pg.wait_for_timeout(1400)
        pg.screenshot(path=f"{ROOT}/docs/screenshots/{name}.png")

    # settings: sources + scoring tabs
    pg.goto(f"http://127.0.0.1:{PORT}/#/settings")
    pg.wait_for_timeout(900)
    pg.click('button[data-tab="sources"]')
    pg.wait_for_timeout(500)
    pg.screenshot(path=f"{ROOT}/docs/screenshots/settings-sources.png")
    pg.click('button[data-tab="scoring"]')
    pg.wait_for_timeout(500)
    pg.screenshot(path=f"{ROOT}/docs/screenshots/settings-scoring.png")

    # mobile responsive
    m = b.new_page(viewport={"width": 420, "height": 860})
    m.goto(f"http://127.0.0.1:{PORT}/#/overview")
    m.wait_for_timeout(1200)
    m.screenshot(path=f"{ROOT}/docs/screenshots/overview-mobile.png")
    b.close()

proc.terminate()
print("ERRORS:" if errors else "NO JS ERRORS")
for e in errors[:10]:
    print(" ", e)

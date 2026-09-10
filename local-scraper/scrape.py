#!/usr/bin/env python3
"""Scraper d'ocupació dels pàrquings Saba de Terrassa.

Llegeix les fitxes públiques de saba.es, n'extreu el nombre de places totals i
disponibles, i afegeix una fila per pàrquing al CSV del dia (data/AAAA/AAAA-MM-DD.csv).

Només fa servir la biblioteca estàndard de Python (>= 3.9).

Ús:
    python3 scrape.py --once        # una sola captura (per a cron)
    python3 scrape.py --loop        # captura contínua, alineada al minut (per a launchd/systemd)
    python3 scrape.py --once --dry-run   # mostra el resultat sense escriure res
"""

from __future__ import annotations

import argparse
import csv
import json
import logging
import re
import sys
import time
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

ROOT = Path(__file__).resolve().parent
DATA_DIR = ROOT / "data"
LOG_DIR = ROOT / "logs"
PARKINGS_FILE = ROOT / "parkings.json"

LOCAL_TZ = ZoneInfo("Europe/Madrid")
USER_AGENT = (
    "parking-terrassa-dataset/1.0 "
    "(dataset obert d'ocupació de pàrquings; contacte al repositori)"
)
TIMEOUT_S = 20
RETRIES = 2
RETRY_WAIT_S = 3

CSV_FIELDS = [
    "timestamp_utc",
    "timestamp_local",
    "parking_id",
    "parking_slug",
    "capacity",
    "available",
    "occupied",
    "occupancy_pct",
]

# Exemple del fragment HTML que es parseja:
#   <div class="available-places">Places: <strong>297</strong>    | Places disponibles: <strong>  230</strong></div>
AVAILABLE_RE = re.compile(
    r'class="available-places">\s*Places:\s*<strong>\s*(\d+)\s*</strong>'
    r".*?Places disponibles:\s*<strong>\s*(\d+)\s*</strong>",
    re.S,
)

log = logging.getLogger("scrape")


class ParseError(Exception):
    pass


def load_parkings() -> list[dict]:
    with PARKINGS_FILE.open(encoding="utf-8") as f:
        return json.load(f)


def fetch(url: str) -> str:
    req = urllib.request.Request(
        url,
        headers={
            "User-Agent": USER_AGENT,
            "Accept-Language": "ca,es;q=0.8",
            "Cache-Control": "no-cache",
        },
    )
    last_err: Exception | None = None
    for attempt in range(RETRIES + 1):
        try:
            with urllib.request.urlopen(req, timeout=TIMEOUT_S) as resp:
                return resp.read().decode("utf-8", errors="replace")
        except (urllib.error.URLError, TimeoutError, OSError) as e:
            last_err = e
            if attempt < RETRIES:
                time.sleep(RETRY_WAIT_S)
    raise last_err  # type: ignore[misc]


def parse(html: str) -> tuple[int, int]:
    """Retorna (capacity, available) a partir de l'HTML de la fitxa."""
    m = AVAILABLE_RE.search(html)
    if not m:
        raise ParseError("no s'ha trobat el bloc 'available-places'")
    capacity, available = int(m.group(1)), int(m.group(2))
    if available > capacity:
        raise ParseError(f"places disponibles ({available}) > capacitat ({capacity})")
    return capacity, available


def scrape_one(parking: dict, slot_utc: datetime) -> dict | None:
    try:
        html = fetch(parking["url"])
        capacity, available = parse(html)
    except ParseError as e:
        # Guardem l'HTML per poder diagnosticar canvis a la pàgina.
        dump = LOG_DIR / f"last-parse-error-{parking['slug']}.html"
        try:
            dump.write_text(html, encoding="utf-8")  # type: ignore[possibly-undefined]
        except Exception:
            pass
        log.error("%s: error de parseig: %s", parking["slug"], e)
        return None
    except Exception as e:
        log.error("%s: error de descàrrega: %s", parking["slug"], e)
        return None

    occupied = capacity - available
    return {
        "timestamp_utc": slot_utc.strftime("%Y-%m-%dT%H:%M:%SZ"),
        "timestamp_local": slot_utc.astimezone(LOCAL_TZ).isoformat(timespec="seconds"),
        "parking_id": parking["id"],
        "parking_slug": parking["slug"],
        "capacity": capacity,
        "available": available,
        "occupied": occupied,
        "occupancy_pct": round(100 * occupied / capacity, 1) if capacity else "",
    }


def csv_path_for(slot_utc: datetime) -> Path:
    local = slot_utc.astimezone(LOCAL_TZ)
    return DATA_DIR / f"{local:%Y}" / f"{local:%Y-%m-%d}.csv"


def append_rows(rows: list[dict], slot_utc: datetime) -> Path:
    path = csv_path_for(slot_utc)
    path.parent.mkdir(parents=True, exist_ok=True)
    new_file = not path.exists() or path.stat().st_size == 0
    with path.open("a", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=CSV_FIELDS, lineterminator="\n")
        if new_file:
            w.writeheader()
        w.writerows(rows)
    return path


def current_slot() -> datetime:
    """Instant actual en UTC, truncat al minut."""
    return datetime.now(timezone.utc).replace(second=0, microsecond=0)


def run_once(parkings: list[dict], dry_run: bool = False) -> int:
    slot = current_slot()
    with ThreadPoolExecutor(max_workers=len(parkings)) as ex:
        results = list(ex.map(lambda p: scrape_one(p, slot), parkings))
    rows = [r for r in results if r is not None]

    if dry_run:
        print(json.dumps(rows, ensure_ascii=False, indent=2))
    elif rows:
        path = append_rows(rows, slot)
        log.info(
            "%s: %s -> %s",
            slot.strftime("%H:%M"),
            ", ".join(f"{r['parking_slug']}={r['available']}/{r['capacity']}" for r in rows),
            path.relative_to(ROOT),
        )
    failures = len(parkings) - len(rows)
    return 1 if failures else 0


def run_loop(parkings: list[dict]) -> None:
    log.info("mode continu: captura cada minut (Ctrl+C per aturar)")
    while True:
        now = time.time()
        next_minute = (int(now // 60) + 1) * 60
        time.sleep(max(0.0, next_minute - now))
        try:
            run_once(parkings)
        except Exception:
            log.exception("error inesperat a la captura")


def setup_logging(to_file: bool) -> None:
    handlers: list[logging.Handler] = [logging.StreamHandler(sys.stderr)]
    if to_file:
        LOG_DIR.mkdir(exist_ok=True)
        handlers.append(logging.FileHandler(LOG_DIR / "scrape.log", encoding="utf-8"))
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(message)s",
        handlers=handlers,
    )


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    mode = ap.add_mutually_exclusive_group(required=True)
    mode.add_argument("--once", action="store_true", help="fa una sola captura i surt")
    mode.add_argument("--loop", action="store_true", help="captura cada minut indefinidament")
    ap.add_argument("--dry-run", action="store_true", help="no escriu al CSV, mostra el resultat per pantalla")
    args = ap.parse_args(argv)

    setup_logging(to_file=not args.dry_run)
    parkings = load_parkings()

    if args.loop:
        try:
            run_loop(parkings)
        except KeyboardInterrupt:
            log.info("aturat")
        return 0
    return run_once(parkings, dry_run=args.dry_run)


if __name__ == "__main__":
    sys.exit(main())

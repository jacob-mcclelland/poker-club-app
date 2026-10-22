#!/usr/bin/env python3
"""
Season Health Check — All-In Poker Club
Queries Firestore and flags data anomalies for the active season at a given venue.

Usage: python scripts/season_health.py [venue]
  venue: "Tight End" (default) or "Wild Corgi"

Checks performed:
  1. Per-game attendance over capacity (single game > 46)
  2. Bounty vs checkin discrepancy > 5 on the same game
  3. Duplicate bounty records (same player/date/game recorded more than once)
  4. Player with implausibly high individual bounty count (> half the game size)
  5. Scheduled Regular game nights with no bounty data at all
  6. Scheduled game nights with no checkin data at all
"""

import os
import sys
import json
import urllib.request
from datetime import datetime
from collections import defaultdict

API_KEY = "demo-api-key"
PROJECT_ID = "demo-poker"
# The Firestore emulator, when FIRESTORE_EMULATOR_HOST is set (see CLAUDE.md).
_EMULATOR = os.environ.get("FIRESTORE_EMULATOR_HOST")
_HOST = f"http://{_EMULATOR}" if _EMULATOR else "https://firestore.googleapis.com"
BASE_URL = f"{_HOST}/v1/projects/{PROJECT_ID}/databases/(default)/documents"

CAPACITY_LIMIT = 46       # single-game attendance ceiling
DISCREPANCY_THRESHOLD = 5 # bounty vs checkin diff that triggers a flag


# ---------------------------------------------------------------------------
# Firestore helpers
# ---------------------------------------------------------------------------

def parse_date(s):
    if not s:
        return None
    parts = s.strip().split("/")
    if len(parts) == 3:
        try:
            return datetime(int(parts[2]), int(parts[0]), int(parts[1]))
        except ValueError:
            pass
    return None

def fmt(s):
    d = parse_date(s)
    return f"{d.month}/{d.day}/{d.year}" if d else s

def get_str(f, k):  return f.get(k, {}).get("stringValue", "")
def get_int(f, k, d=0):
    v = f.get(k, {})
    return int(v["integerValue"]) if "integerValue" in v else d

def firestore_query(collection, filters):
    url = f"{BASE_URL}:runQuery?key={API_KEY}"
    if len(filters) == 1:
        where = {"fieldFilter": {
            "field": {"fieldPath": filters[0]["field"]},
            "op": filters[0]["op"],
            "value": {filters[0]["vtype"]: filters[0]["value"]}
        }}
    else:
        where = {"compositeFilter": {"op": "AND", "filters": [
            {"fieldFilter": {
                "field": {"fieldPath": f["field"]},
                "op": f["op"],
                "value": {f["vtype"]: f["value"]}
            }} for f in filters
        ]}}
    body = json.dumps({"structuredQuery": {"from": [{"collectionId": collection}], "where": where}}).encode()
    req = urllib.request.Request(url, data=body, headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req) as r:
        return [i["document"]["fields"] for i in json.loads(r.read()) if i.get("document")]


# ---------------------------------------------------------------------------
# Data fetchers
# ---------------------------------------------------------------------------

def fetch_active_season(venue):
    docs = firestore_query("seasons", [
        {"field": "venue",  "op": "EQUAL", "vtype": "stringValue",  "value": venue},
        {"field": "active", "op": "EQUAL", "vtype": "booleanValue", "value": True}
    ])
    if not docs:
        return None
    return max(docs, key=lambda d: parse_date(get_str(d, "startDate")) or datetime.min)

def fetch_schedule(venue, start_str, champ_str):
    start, end = parse_date(start_str), parse_date(champ_str)
    docs = firestore_query("schedule", [
        {"field": "venue", "op": "EQUAL", "vtype": "stringValue", "value": venue}
    ])
    entries = []
    for d in docs:
        ds = get_str(d, "date")
        gd = parse_date(ds)
        if gd and start <= gd <= end:
            entries.append({"date": fmt(ds), "type": get_str(d, "type") or "Regular"})
    return sorted(entries, key=lambda e: parse_date(e["date"]))

def fetch_bounties(venue):
    return firestore_query("bounties", [
        {"field": "venue", "op": "EQUAL", "vtype": "stringValue", "value": venue}
    ])

def fetch_checkins(venue):
    return firestore_query("checkins", [
        {"field": "venue", "op": "EQUAL", "vtype": "stringValue", "value": venue}
    ])


# ---------------------------------------------------------------------------
# Analysis helpers
# ---------------------------------------------------------------------------

def group_bounties(docs, date_set):
    """
    Returns:
      totals:     {(date, gameNum): int}          — sum of counts + 1 (winner)
      per_player: {(date, gameNum): {player: count}}
      raw_docs:   {(date, gameNum): [doc, ...]}   — for duplicate detection
    """
    raw = defaultdict(list)
    for d in docs:
        date = fmt(get_str(d, "date"))
        gn   = get_int(d, "gameNum", 1)
        if date in date_set:
            raw[(date, gn)].append(d)

    totals, per_player = {}, {}
    for key, ddocs in raw.items():
        player_map = defaultdict(int)
        for d in ddocs:
            player_map[get_str(d, "player").strip().lower()] += get_int(d, "count", 0)
        per_player[key] = dict(player_map)
        totals[key] = sum(player_map.values()) + 1

    return totals, per_player, dict(raw)

def group_checkins(docs, date_set):
    """Returns {(date, gameNum): int} unique player counts."""
    groups = defaultdict(set)
    for d in docs:
        date   = fmt(get_str(d, "date"))
        gn     = get_int(d, "gameNum", 1)
        player = get_str(d, "player").strip().lower()
        if date in date_set and player:
            groups[(date, gn)].add(player)
    return {k: len(v) for k, v in groups.items()}


# ---------------------------------------------------------------------------
# Checks
# ---------------------------------------------------------------------------

def flag(severity, check, date, game_num, detail):
    return {"severity": severity, "check": check, "date": date, "gameNum": game_num, "detail": detail}

def check_capacity(totals):
    """Flag any single game where attendance exceeds CAPACITY_LIMIT."""
    flags = []
    for (date, gn), count in totals.items():
        if count > CAPACITY_LIMIT:
            flags.append(flag("error", "over_capacity",
                date, gn,
                f"Game {gn} attendance = {count} (limit {CAPACITY_LIMIT})"))
    return flags

def check_discrepancy(b_totals, c_totals, all_dates):
    """Flag bounty vs checkin diff > threshold."""
    flags = []
    all_keys = set(b_totals) | set(c_totals)
    for (date, gn) in all_keys:
        if date not in all_dates:
            continue
        b = b_totals.get((date, gn), 0)
        c = c_totals.get((date, gn), 0)
        diff = abs(b - c)
        if diff > DISCREPANCY_THRESHOLD:
            flags.append(flag("error", "bounty_checkin_discrepancy",
                date, gn,
                f"Game {gn}: bounties={b}, checkins={c}, diff={diff}"))
    return flags

def check_duplicates(raw_docs, date_set):
    """Flag any player recorded more than once for the same game."""
    flags = []
    for (date, gn), docs in raw_docs.items():
        if date not in date_set:
            continue
        seen = defaultdict(int)
        for d in docs:
            seen[get_str(d, "player").strip().lower()] += 1
        dupes = {p: n for p, n in seen.items() if n > 1}
        if dupes:
            detail = ", ".join(f"{p} x{n}" for p, n in sorted(dupes.items()))
            flags.append(flag("error", "duplicate_bounty_record",
                date, gn,
                f"Game {gn} duplicate entries: {detail}"))
    return flags

def check_implausible_individual(per_player, b_totals):
    """Flag a player whose individual bounty count exceeds half the game size."""
    flags = []
    for (date, gn), players in per_player.items():
        game_size = b_totals.get((date, gn), 0)
        if game_size == 0:
            continue
        ceiling = max(game_size // 2, 5)
        for player, count in players.items():
            if count > ceiling:
                flags.append(flag("warning", "implausible_individual_bounty",
                    date, gn,
                    f"{player} collected {count} bounties in a ~{game_size}-player game (ceiling {ceiling})"))
    return flags

def check_missing_bounties(schedule, b_totals):
    """Flag Regular scheduled games that have no bounty data."""
    flags = []
    for entry in schedule:
        if entry["type"] != "Regular":
            continue
        date = entry["date"]
        has_data = any(d == date for (d, _) in b_totals)
        if not has_data:
            flags.append(flag("warning", "no_bounty_data",
                date, None,
                f"Regular game on {date} has no bounty records"))
    return flags

def check_missing_checkins(schedule, c_totals):
    """Flag any scheduled game that has no checkin data."""
    flags = []
    for entry in schedule:
        date = entry["date"]
        has_data = any(d == date for (d, _) in c_totals)
        if not has_data:
            flags.append(flag("warning", "no_checkin_data",
                date, None,
                f"{entry['type']} game on {date} has no checkin records"))
    return flags


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def audit_venue(venue):
    """Run all health checks for one venue. Returns a result dict."""
    season_doc = fetch_active_season(venue)
    if not season_doc:
        return {"venue": venue, "error": f"No active season found for: {venue}"}

    season_number     = get_int(season_doc, "seasonNumber")
    season_name       = get_str(season_doc, "name")
    start_date        = get_str(season_doc, "startDate")
    end_date          = get_str(season_doc, "endDate")
    championship_date = get_str(season_doc, "championshipDate")

    schedule = fetch_schedule(venue, start_date, championship_date)

    all_dates     = {e["date"] for e in schedule}
    regular_dates = {e["date"] for e in schedule if e["type"] == "Regular"}

    all_bounties = fetch_bounties(venue)
    all_checkins = fetch_checkins(venue)

    b_totals, per_player, raw_docs = group_bounties(all_bounties, all_dates)
    c_totals = group_checkins(all_checkins, all_dates)

    flags = []
    flags += check_capacity(b_totals)
    flags += check_capacity(c_totals)
    flags += check_discrepancy(b_totals, c_totals, regular_dates)
    flags += check_duplicates(raw_docs, all_dates)
    flags += check_implausible_individual(per_player, b_totals)
    flags += check_missing_bounties(schedule, b_totals)
    flags += check_missing_checkins(schedule, c_totals)

    # Deduplicate (capacity can fire from both bounty and checkin sources)
    seen, unique_flags = set(), []
    for f in flags:
        key = (f["check"], f["date"], f["gameNum"], f["detail"])
        if key not in seen:
            seen.add(key)
            unique_flags.append(f)

    unique_flags.sort(key=lambda f: (0 if f["severity"] == "error" else 1, f["date"] or ""))

    errors   = [f for f in unique_flags if f["severity"] == "error"]
    warnings = [f for f in unique_flags if f["severity"] == "warning"]

    return {
        "venue": venue,
        "season": {"name": season_name, "number": season_number,
                   "startDate": start_date, "endDate": end_date,
                   "championshipDate": championship_date},
        "schedule": schedule,
        "summary": {"errors": len(errors), "warnings": len(warnings), "total": len(unique_flags)},
        "flags": unique_flags
    }


def main():
    # If a specific venue is passed, audit only that one.
    # Otherwise audit all venues.
    ALL_VENUES = ["Tight End", "Wild Corgi"]
    venues = [sys.argv[1]] if len(sys.argv) > 1 else ALL_VENUES

    results = [audit_venue(v) for v in venues]
    print(json.dumps(results if len(results) > 1 else results[0], indent=2))


if __name__ == "__main__":
    main()

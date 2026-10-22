#!/usr/bin/env python3
"""Check schedule-entry copy before a season is loaded into Firestore.

The 10:00 game-day push is built from schedule fields by a template in
functions/index.js (buildGamedayAnnouncement). Theme, gear and note are stored
exactly as typed, and nobody checks that they read naturally inside the
sentence. This tool renders the exact sentence for each entry, runs a few
deterministic checks, and (optionally) asks Jev three typed questions per entry.

It proposes nothing and writes nothing: no Firestore, no deploy, no edits to
any file. It only prints a report.

    python functions/scripts/check_schedule_copy.py --entries entries.json
    python functions/scripts/check_schedule_copy.py --from-season-script functions/scripts/set-season-30-35-themes.js
    python functions/scripts/check_schedule_copy.py --expectations functions/scripts/schedule_copy_expectations.json

Add --offline-answers answers.json to use canned answers instead of calling
Jev, or --no-jev to run only the deterministic checks.

Input entries are a JSON list of
    {date, venue, type, theme, gearDescription, announcementNote}
and may carry an optional "id". Offline answers are a JSON object keyed by the
entry id, or by "date|venue" when there is no id:
    {"2026-10-20|Tight End": {"reads_naturally": 0.2, "theme_kind": "real_theme",
                              "note_publishable": 0.9, "order_flip": false}}
A value may also be a full Jev answer object ({"noul": 0.2} / {"choice": "x"}).
"""

from __future__ import annotations

import argparse
import json
import math
import re
import sys
from pathlib import Path

LABEL = "poker_schedule_copy"
JEV_TOOLS_DIR = "C:/jev-tools"

# Review threshold from the brief: below this is "low".
LOW_BELOW = 0.5

ENTRY_FIELDS = ("date", "venue", "type", "theme", "gearDescription", "announcementNote")

# Dashes are written as escapes so this file carries none itself.
EM_DASH = "\u2014"
EN_DASH = "\u2013"

# --- the template, mirrored from functions/index.js --------------------------
#
# The line mirrored (buildGamedayAnnouncement, index.js:4404 on 2026-10-02):
#   `Tonight's theme is ${themeForSentence.toUpperCase()}, so wear your best ${gearDescription} and show up by 6:50 to receive your bonus.`
# TEMPLATE_JS is that literal's text; the unit tests check it is still present
# in index.js, so a change to the template there is noticed here.
TEMPLATE_JS = (
    "Tonight's theme is ${themeForSentence.toUpperCase()}, so wear your best "
    "${gearDescription} and show up by 6:50 to receive your bonus."
)
TEMPLATE_PY = (
    "Tonight's theme is {theme}, so wear your best {gear} "
    "and show up by 6:50 to receive your bonus."
)

# Mirrors GAMEDAY_GEAR_MAP, GAMEDAY_SPORT_WORDS and the special-night lines.
GEAR_MAP = {
    "greenery": "GREEN or PLANT/HERB inspired gear",
    "cowboys": "WESTERN or COWBOY inspired gear",
    "casino royale": "BLACK TIE or FORMAL inspired gear",
    "halloween": "HALLOWEEN COSTUME or SPOOKY inspired gear",
}
SPORT_WORDS = [
    "baseball", "football", "hockey", "basketball", "soccer", "golf",
    "tennis", "boxing", "wrestling", "rugby", "cricket", "volleyball",
    "lacrosse", "softball",
]
BIG_STACK_LINE = "Tonight is our BIG STACK tournament! Show up by 6:50 to get your bonus."
CHAMPIONSHIP_LINE = "Tonight is CHAMPIONSHIP NIGHT! Show up by 6:50 to get your bonus."

JS_WHITESPACE_CLASS = (
    r"[\u0009\u000A\u000B\u000C\u000D\u0020\u00A0\u1680"
    r"\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200A"
    r"\u2028\u2029\u202F\u205F\u3000\uFEFF]"
)

_PLACEHOLDER_RE = re.compile(r"\(placeholder\)" + JS_WHITESPACE_CLASS + r"*\Z", re.IGNORECASE)


class NoAnswer(Exception):
    """No model answer is available for an entry (offline gap or Jev failure)."""


# --- JS-compatible string helpers ---------------------------------------------

def _s(value) -> str:
    """JS String(value || '')."""
    return "" if not value else str(value)


def _trim(text: str) -> str:
    """JS String.prototype.trim: strips ECMAScript WhiteSpace and LineTerminator only.

    Python's \\s would also strip U+001C to U+001F and U+0085, which JS keeps.
    """
    return re.sub(r"^" + JS_WHITESPACE_CLASS + r"+|" + JS_WHITESPACE_CLASS + r"+\Z", "", text)


def sanitize_theme(raw) -> str:
    """sanitizeGamedayTheme: strip a trailing '(placeholder)' marker, then trim."""
    return _trim(_PLACEHOLDER_RE.sub("", _s(raw), count=1))


def _lookup_gameday_gear(theme_lower: str):
    # Mirrors the plain object lookup at index.js:4325.
    if theme_lower in GEAR_MAP:
        return GEAR_MAP[theme_lower]
    if theme_lower == "constructor":
        return "function Object() { [native code] }"
    if theme_lower == "__proto__":
        return "[object Object]"
    return None


def _theme_for_sentence(entry: dict):
    """buildGamedayAnnouncement's themeForSentence, or None when the push sends
    only the special Big Stack / Championship line (index.js:4375-4400)."""
    raw_theme = _trim(_s(entry.get("theme")))
    sanitized = sanitize_theme(raw_theme)
    was_placeholder = bool(_PLACEHOLDER_RE.search(raw_theme))
    echoes_type = sanitized.lower() == _trim(_s(entry.get("type"))).lower()
    theme_is_real = len(sanitized) > 0 and not was_placeholder and not echoes_type

    event_type = entry.get("type")
    if event_type in ("Big Stack", "Championship") and not theme_is_real:
        return None
    return sanitized if theme_is_real else (event_type or "Poker Night")


def _prototype_gear_key(entry: dict):
    """The Object.prototype key the app's gear lookup would hit, or None.

    The lookup runs only when custom gear is blank (index.js:4321-4325).
    """
    if _trim(_s(entry.get("gearDescription"))):
        return None
    theme = _theme_for_sentence(entry)
    if theme is None:
        return None
    theme_lower = _s(theme).lower()
    return theme_lower if theme_lower in ("constructor", "__proto__") else None


def gear_description(entry: dict, theme) -> str:
    """gamedayGearDescription: custom gear, else the built-in fallbacks."""
    custom = _trim(_s(entry.get("gearDescription")))
    if custom:
        return custom
    theme_lower = _s(theme).lower()
    mapped_gear = _lookup_gameday_gear(theme_lower)
    if mapped_gear:
        return mapped_gear
    sport = next((w for w in SPORT_WORDS if w in theme_lower), None)
    if sport:
        return f"{sport} gear or the jersey/colors of your favorite {sport} team"
    return f"{theme} inspired gear" if theme else "theme inspired gear"


def render_push_sentence(entry: dict) -> str:
    """The sentence the 10:00 push puts in the body for this entry.

    Follows buildGamedayAnnouncement. For a Big Stack or Championship night with
    no real theme the push has no theme/gear sentence, only the special line, so
    that line is returned instead.
    """
    theme_for_sentence = _theme_for_sentence(entry)
    if theme_for_sentence is None:
        return BIG_STACK_LINE if entry.get("type") == "Big Stack" else CHAMPIONSHIP_LINE

    gear = gear_description(entry, theme_for_sentence)
    return TEMPLATE_PY.format(theme=theme_for_sentence.upper(), gear=gear)


# --- deterministic checks -----------------------------------------------------

def deterministic_flags(entry: dict) -> list[str]:
    """Checks that need no model. Returns flag names, empty when clean."""
    flags: list[str] = []
    for field, name in (("theme", "theme"), ("gearDescription", "gear"), ("announcementNote", "note")):
        text = _s(entry.get(field))
        if EM_DASH in text or EN_DASH in text:
            flags.append(f"dash:{name}")
    if not _trim(_s(entry.get("gearDescription"))):
        flags.append("gear_empty")
    theme = sanitize_theme(entry.get("theme"))
    if theme and theme.lower() == _trim(_s(entry.get("type"))).lower():
        flags.append("theme_equals_type")
    if _prototype_gear_key(entry) is not None:
        flags.append("theme_prototype_key")
    return flags


# --- Jev questions ------------------------------------------------------------
# Plain dicts in the same shape the client's noul() and choice() builders return,
# so the wording can be checked without importing the client.

Q_READS = "The rendered sentence reads as natural, grammatical English that a bar could send to customers"
Q_THEME = "What kind of value is the theme field"
Q_THEME_CRITERIA = {
    "real_theme": "a real dress-up or party theme",
    "filler": "a placeholder such as TBD, N/A, a dash or 'theme'",
    "event_type": "just repeats the kind of event, such as Championship Night or Poker Night",
    "other": "something else",
}
Q_NOTE = "The announcement note is friendly, ordinary event information that a bar would be comfortable sending as-is to all of its customers"


def build_questions(entry: dict) -> dict:
    questions = {
        "reads_naturally": {"type": "noul", "instructions": Q_READS},
        "theme_kind": {"type": "choice", "instructions": Q_THEME, "criteria": dict(Q_THEME_CRITERIA)},
    }
    if _trim(_s(entry.get("announcementNote"))):
        questions["note_publishable"] = {"type": "noul", "instructions": Q_NOTE}
    return questions


def build_state(entry: dict, sentence: str) -> dict:
    return {"entry": {k: _s(entry.get(k)) for k in ENTRY_FIELDS}, "rendered_sentence": sentence}


# --- answers ------------------------------------------------------------------

def _answer_value(ans):
    if isinstance(ans, dict):
        for key in ("value", "noul", "choice", "score"):
            if ans.get(key) is not None:
                return ans[key]
        return None
    return ans


def _number(value):
    if isinstance(value, bool):
        return None
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return None if math.isnan(number) else number


def _as_answer(qtype: str, raw) -> dict:
    """Normalise a canned value into the shape Jev's ask() returns."""
    if isinstance(raw, dict):
        ans = dict(raw)
    else:
        ans = {}
        ans["noul" if qtype == "noul" else "choice"] = raw
    ans.setdefault("type", qtype)
    ans["value"] = _answer_value(ans)
    ans.setdefault("order_flip", None)
    return ans


class OfflineAnswers:
    """Canned answers keyed by entry id, or by 'date|venue'."""

    def __init__(self, data: dict):
        if not isinstance(data, dict):
            raise ValueError("offline answers must be a JSON object keyed by entry")
        self.data = data

    @classmethod
    def from_file(cls, path):
        return cls(json.loads(Path(path).read_text(encoding="utf-8")))

    @staticmethod
    def keys_for(entry: dict) -> list[str]:
        keys = []
        if entry.get("id"):
            keys.append(str(entry["id"]))
        keys.append(f"{_s(entry.get('date'))}|{_s(entry.get('venue'))}")
        return keys

    def __call__(self, entry: dict, state: dict, questions: dict) -> dict:
        record = None
        for key in self.keys_for(entry):
            if key in self.data:
                record = self.data[key]
                break
        if record is None:
            raise NoAnswer(f"no offline answers for {self.keys_for(entry)[-1]}")
        answers = {}
        for qid, question in questions.items():
            if qid in record:
                answers[qid] = _as_answer(question["type"], record[qid])
        if "order_flip" in record and "theme_kind" in answers:
            answers["theme_kind"]["order_flip"] = bool(record["order_flip"])
        return answers


def make_live_asker():
    """Build an asker backed by the Jev client. The client is imported here, lazily."""
    if JEV_TOOLS_DIR not in sys.path:
        sys.path.insert(0, JEV_TOOLS_DIR)
    from jev.client import Jev, JevError  # noqa: PLC0415 - deliberately lazy

    jev = Jev()

    def ask(entry: dict, state: dict, questions: dict) -> dict:
        try:
            return jev.ask(state, questions, label=LABEL)
        except JevError as exc:
            raise NoAnswer(str(exc)) from exc

    return ask


# --- checking -----------------------------------------------------------------

def _order_flip(answers: dict):
    flips = [a.get("order_flip") for a in answers.values() if isinstance(a, dict)]
    if any(f is True for f in flips):
        return True
    if any(f is False for f in flips):
        return False
    return None


def check_entry(entry: dict, asker=None) -> dict:
    """Render, run the deterministic checks, and (when asker is given) the model checks."""
    sentence = render_push_sentence(entry)
    flags = deterministic_flags(entry)
    result = {
        "id": entry.get("id"),
        "date": _s(entry.get("date")),
        "venue": _s(entry.get("venue")),
        "type": _s(entry.get("type")),
        "theme": _s(entry.get("theme")),
        "gearDescription": _s(entry.get("gearDescription")),
        "announcementNote": _s(entry.get("announcementNote")),
        "rendered_sentence": sentence,
        "deterministic_flags": flags,
        "model_run": asker is not None,
        "reads_naturally": None,
        "theme_kind": None,
        "note_publishable": None,
        "order_flip": None,
        "error": None,
    }
    reasons = list(flags)

    if asker is not None:
        questions = build_questions(entry)
        try:
            answers = asker(entry, build_state(entry, sentence), questions)
        except NoAnswer as exc:
            result["error"] = str(exc)
            answers = {}

        reads = _number(_answer_value(answers.get("reads_naturally")))
        kind = _answer_value(answers.get("theme_kind"))
        note = _number(_answer_value(answers.get("note_publishable")))
        result["reads_naturally"] = reads
        result["theme_kind"] = kind if isinstance(kind, str) else None
        result["note_publishable"] = note
        result["order_flip"] = _order_flip(answers)

        asked_note = "note_publishable" in questions
        missing = (
            reads is None
            or result["theme_kind"] is None
            or (asked_note and note is None)
        )
        if missing:
            reasons.append("no_answer")
        if reads is not None and reads < LOW_BELOW:
            reasons.append(f"reads_naturally<{LOW_BELOW}")
        if result["theme_kind"] is not None and result["theme_kind"] != "real_theme":
            reasons.append(f"theme_kind={result['theme_kind']}")
        if note is not None and note < LOW_BELOW:
            reasons.append(f"note_publishable<{LOW_BELOW}")

    result["review_reasons"] = reasons
    result["flagged"] = bool(reasons)
    return result


def check_entries(entries: list[dict], asker=None) -> list[dict]:
    return [check_entry(entry, asker) for entry in entries]


# --- loading entries ----------------------------------------------------------

def _normalise_entry(raw, where: str) -> dict:
    if not isinstance(raw, dict):
        raise ValueError(f"{where}: entry must be an object")
    entry = dict(raw)
    for field in ENTRY_FIELDS:
        entry.setdefault(field, "")
    if not _s(entry["date"]) or not _s(entry["venue"]):
        raise ValueError(f"{where}: entry needs a date and a venue")
    return entry


def load_entries(path) -> list[dict]:
    data = json.loads(Path(path).read_text(encoding="utf-8"))
    if not isinstance(data, list):
        raise ValueError(f"{path}: expected a JSON list of entries")
    return [_normalise_entry(item, f"{path}[{i}]") for i, item in enumerate(data)]


# --- season script parser -----------------------------------------------------

_ESCAPE_RE = re.compile(r"\\(u[0-9a-fA-F]{4}|.)", re.DOTALL)
_SIMPLE_ESCAPES = {"n": "\n", "t": "\t", "r": "\r"}
_KV_RE = re.compile(
    r"""\s*(?P<key>[A-Za-z_$][\w$]*)\s*:\s*(?P<q>['"])(?P<val>(?:\\.|(?!(?P=q))[^\\])*)(?P=q)""",
    re.DOTALL,
)


def _unescape(text: str) -> str:
    def repl(match):
        token = match.group(1)
        if len(token) == 5 and token[0] == "u":
            return chr(int(token[1:], 16))
        return _SIMPLE_ESCAPES.get(token, token)

    return _ESCAPE_RE.sub(repl, text)


def _array_body(text: str, start: int) -> str:
    """Text of the array literal that opens just before `start`, comments removed."""
    out: list[str] = []
    depth = 1
    quote = None
    i = 0
    n = len(text)
    i = start
    while i < n:
        c = text[i]
        if quote:
            out.append(c)
            if c == "\\" and i + 1 < n:
                out.append(text[i + 1])
                i += 2
                continue
            if c == quote:
                quote = None
            i += 1
            continue
        if c in "'\"`":
            quote = c
            out.append(c)
            i += 1
            continue
        if text.startswith("//", i):
            j = text.find("\n", i)
            i = n if j < 0 else j
            continue
        if text.startswith("/*", i):
            j = text.find("*/", i + 2)
            i = n if j < 0 else j + 2
            out.append(" ")
            continue
        if c == "[":
            depth += 1
        elif c == "]":
            depth -= 1
            if depth == 0:
                return "".join(out)
        out.append(c)
        i += 1
    raise ValueError("THEMES array is not terminated")


def _object_blocks(body: str) -> list[str]:
    blocks: list[str] = []
    depth = 0
    quote = None
    begin = None
    i = 0
    n = len(body)
    while i < n:
        c = body[i]
        if quote:
            if c == "\\":
                i += 2
                continue
            if c == quote:
                quote = None
        elif c in "'\"`":
            quote = c
        elif c == "{":
            if depth == 0:
                begin = i + 1
            depth += 1
        elif c == "}":
            depth -= 1
            if depth == 0 and begin is not None:
                blocks.append(body[begin:i])
                begin = None
        i += 1
    return blocks


def _parse_object(block: str) -> dict:
    out: dict[str, str] = {}
    pos = 0
    n = len(block)
    while True:
        while pos < n and (block[pos].isspace() or block[pos] == ","):
            pos += 1
        if pos >= n:
            break
        match = _KV_RE.match(block, pos)
        if not match:
            raise ValueError(f"unsupported syntax in THEMES object near {block[pos:pos + 40]!r}")
        out[match.group("key")] = _unescape(match.group("val"))
        pos = match.end()
        while pos < n and block[pos].isspace():
            pos += 1
        if pos < n and block[pos] != ",":
            raise ValueError(
                f"unsupported value after {match.group('key')!r} (string concatenation?) "
                f"near {block[pos:pos + 40]!r}"
            )
    return out


def _iso_from_mdy(text: str) -> str:
    match = re.fullmatch(r"\s*(\d{1,2})/(\d{1,2})/(\d{4})\s*", text)
    if not match:
        raise ValueError(f"date {text!r} is not M/D/YYYY")
    month, day, year = match.groups()
    return f"{year}-{int(month):02d}-{int(day):02d}"


def parse_season_script(text: str) -> list[dict]:
    """Extract the THEMES array from set-season-30-35-themes.js.

    Each {te, wc, theme, gear} object becomes one Tight End entry (te date) and
    one Wild Corgi entry (wc date). Type is 'Regular' and the note is empty: the
    script sets neither (it only writes theme and gearDescription).
    """
    opener = re.search(r"\bTHEMES\s*=\s*\[", text)
    if not opener:
        raise ValueError("no THEMES array literal found")
    body = _array_body(text, opener.end())
    entries: list[dict] = []
    blocks = _object_blocks(body)
    if not blocks:
        raise ValueError("THEMES array holds no objects")
    for index, block in enumerate(blocks):
        obj = _parse_object(block)
        missing = [k for k in ("te", "wc", "theme", "gear") if k not in obj]
        if missing:
            raise ValueError(f"THEMES object {index} is missing {', '.join(missing)}")
        for key, venue in (("te", "Tight End"), ("wc", "Wild Corgi")):
            entries.append(
                {
                    "date": _iso_from_mdy(obj[key]),
                    "venue": venue,
                    "type": "Regular",
                    "theme": obj["theme"],
                    "gearDescription": obj["gear"],
                    "announcementNote": "",
                }
            )
    return entries


def load_season_script(path) -> list[dict]:
    return parse_season_script(Path(path).read_text(encoding="utf-8"))


# --- frozen expectations ------------------------------------------------------

def _resolve_case_entry(case: dict, script_entries: list[dict] | None) -> dict:
    where = f"expectations case {case.get('id')}"
    if "entry" in case:
        return _normalise_entry(case["entry"], where)
    source = case.get("entry_from_season_script")
    if not source:
        raise ValueError(f"{where}: needs 'entry' or 'entry_from_season_script'")
    if script_entries is None:
        raise ValueError(f"{where}: needs a season script")
    wanted_theme = source["theme"].lower()
    for entry in script_entries:
        if entry["theme"].lower() == wanted_theme and entry["venue"] == source["venue"]:
            resolved = dict(entry)
            resolved["id"] = f"expect-{case['id']}"
            return resolved
    raise ValueError(f"{where}: season script has no {source['theme']!r} at {source['venue']}")


def load_expectations(path, season_script_path=None):
    """Return (meta, [(case, entry), ...]) with every entry resolved."""
    path = Path(path)
    meta = json.loads(path.read_text(encoding="utf-8"))
    cases = meta["cases"]
    script_entries = None
    if any("entry_from_season_script" in c for c in cases):
        script = season_script_path or (path.parent / meta["season_script"])
        script_entries = load_season_script(script)
    return meta, [(case, _resolve_case_entry(case, script_entries)) for case in cases]


def _band(value, wanted: str):
    if value is None:
        return False, "no answer"
    ok = value >= LOW_BELOW if wanted == "high" else value < LOW_BELOW
    return ok, f"{value:.2f}"


def score_case(case: dict, result: dict) -> list[tuple[str, bool, str]]:
    """Clauses of one frozen expectation as (clause, met, observed)."""
    expected = case["expected"]
    clauses: list[tuple[str, bool, str]] = []
    if "flagged" in expected:
        reasons = ", ".join(result["review_reasons"]) or "none"
        clauses.append((f"flagged={str(expected['flagged']).lower()}", result["flagged"] == expected["flagged"], reasons))
    for flag in expected.get("flags_include", []):
        clauses.append((f"flag {flag}", flag in result["deterministic_flags"], ", ".join(result["deterministic_flags"]) or "none"))
    for key in ("reads_naturally", "note_publishable"):
        if key in expected:
            ok, observed = _band(result[key], expected[key])
            clauses.append((f"{key} {expected[key]}", ok, observed))
    if "theme_kind" in expected:
        clauses.append((f"theme_kind={expected['theme_kind']}", result["theme_kind"] == expected["theme_kind"], str(result["theme_kind"])))
    return clauses


def run_expectations(path, asker=None, season_script_path=None) -> list[dict]:
    meta, resolved = load_expectations(path, season_script_path)
    scored = []
    for case, entry in resolved:
        result = check_entry(entry, asker)
        clauses = score_case(case, result)
        scored.append(
            {
                "id": case["id"],
                "label": case["label"],
                "met": all(ok for _, ok, _ in clauses),
                "clauses": clauses,
                "known_conflict": case.get("known_conflict"),
                "result": result,
            }
        )
    return scored


# --- output -------------------------------------------------------------------

def _cell(text) -> str:
    return str(text).replace("|", "\\|").replace("\r", " ").replace("\n", " ")


def _fmt_num(value) -> str:
    return "-" if value is None else f"{value:.2f}"


def _fmt_flip(value) -> str:
    return "-" if value is None else ("yes" if value else "no")


def format_table(results: list[dict]) -> str:
    header = [
        "date", "venue", "rendered sentence", "deterministic flags",
        "reads_naturally", "theme_kind", "note_publishable", "order_flip", "review",
    ]
    rows = ["| " + " | ".join(header) + " |", "|" + "|".join(["---"] * len(header)) + "|"]
    for r in results:
        review = "REVIEW: " + ", ".join(r["review_reasons"]) if r["flagged"] else "ok"
        note = r["note_publishable"]
        cells = [
            r["date"], r["venue"], r["rendered_sentence"],
            ", ".join(r["deterministic_flags"]) or "-",
            _fmt_num(r["reads_naturally"]) if r["model_run"] else "-",
            (r["theme_kind"] or "-") if r["model_run"] else "-",
            _fmt_num(note) if r["model_run"] else "-",
            _fmt_flip(r["order_flip"]),
            review,
        ]
        rows.append("| " + " | ".join(_cell(c) for c in cells) + " |")
    flagged = sum(1 for r in results if r["flagged"])
    rows.append("")
    rows.append(f"{flagged} of {len(results)} entries flagged for review.")
    return "\n".join(rows)


def format_expectations(scored: list[dict]) -> str:
    lines = ["| # | expectation | met | clauses (observed) |", "|---|---|---|---|"]
    for item in scored:
        parts = [f"{'ok' if ok else 'NOT MET'}: {name} ({observed})" for name, ok, observed in item["clauses"]]
        if not item["met"] and item["known_conflict"]:
            parts.append("known conflict: " + item["known_conflict"])
        lines.append(f"| {item['id']} | {_cell(item['label'])} | {'yes' if item['met'] else 'no'} | {_cell('; '.join(parts))} |")
    met = sum(1 for item in scored if item["met"])
    lines.append("")
    lines.append(f"{met} of {len(scored)} expectations met.")
    return "\n".join(lines)


# --- command line -------------------------------------------------------------

def _configure_stdout() -> None:
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")
        except (AttributeError, ValueError):
            pass


def _build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(description="Check schedule-entry copy against the game-day push template.")
    p.add_argument("--entries", help="JSON list of {date, venue, type, theme, gearDescription, announcementNote}")
    p.add_argument("--from-season-script", metavar="FILE", help="extract entries from set-season-30-35-themes.js")
    p.add_argument("--expectations", metavar="FILE", help="run the frozen expectations file and report N met")
    p.add_argument("--offline-answers", metavar="FILE", help="canned Jev answers; no network call is made")
    p.add_argument("--no-jev", action="store_true", help="deterministic checks only")
    p.add_argument("--json", action="store_true", help="print machine-readable results")
    return p


def main(argv=None) -> int:
    _configure_stdout()
    parser = _build_parser()
    args = parser.parse_args(argv)

    if args.offline_answers and args.no_jev:
        parser.error("--offline-answers and --no-jev cannot be combined")
    if args.expectations and args.entries:
        parser.error("--expectations cannot be combined with --entries")
    if not (args.entries or args.from_season_script or args.expectations):
        parser.error("give --entries, --from-season-script or --expectations")

    try:
        if args.no_jev:
            asker, source = None, "deterministic checks only"
        elif args.offline_answers:
            asker, source = OfflineAnswers.from_file(args.offline_answers), f"offline answers from {args.offline_answers}"
        else:
            asker, source = make_live_asker(), "Jev (live)"

        if args.expectations:
            scored = run_expectations(args.expectations, asker, args.from_season_script)
            if args.json:
                print(json.dumps(scored, indent=2, ensure_ascii=False))
            else:
                print(f"Model answers: {source}")
                print()
                print(format_expectations(scored))
                print()
                print(format_table([item["result"] for item in scored]))
            return 0

        entries: list[dict] = []
        if args.entries:
            entries.extend(load_entries(args.entries))
        if args.from_season_script:
            entries.extend(load_season_script(args.from_season_script))
        results = check_entries(entries, asker)
    except (OSError, ValueError, json.JSONDecodeError) as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2
    except ImportError as exc:
        print(f"error: could not import the Jev client from {JEV_TOOLS_DIR}: {exc}", file=sys.stderr)
        return 2
    except Exception as exc:  # noqa: BLE001 - JevError at construction (no API key) and the like
        print(f"error: {exc}", file=sys.stderr)
        return 2

    errors = [r for r in results if r["error"]]
    if args.json:
        print(json.dumps(results, indent=2, ensure_ascii=False))
    else:
        print(f"Model answers: {source}")
        print()
        print(format_table(results))
    for r in errors:
        print(f"warning: {r['date']} {r['venue']}: {r['error']}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())

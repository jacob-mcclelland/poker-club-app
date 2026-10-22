#!/usr/bin/env python3
"""Label drafted event titles and descriptions before they are written to Firestore.

The weekly Codex automation `draft-poker-event-content` writes a title and a
description for every scheduled event and stores them as eventContent drafts.
The model that writes the copy is also the only thing asked to check it. This
tool is an independent second look: for each draft it asks Jev one set of typed
questions, judged against the schedule row the draft was written for, and adds
a `contentCheck` object to the draft.

It labels and never blocks. It does not edit a title or a description, it does
not touch Firestore, and it writes nothing except stdout and the --out file.

    python functions/scripts/check_event_copy.py --in drafts.json --out checked.json
    python functions/scripts/check_event_copy.py --in drafts.json --offline-answers answers.json
    python functions/scripts/check_event_copy.py --expectations functions/scripts/event_copy_expectations.json

Add --offline-answers answers.json to use canned answers instead of calling Jev.

Input is a JSON list of
    {"key", "schedule": {date, venue, type, theme, gearDescription, times...},
     "title", "description"}
Venue must be "Tight End" or "Wild Corgi". Keys must be unique.

Output is the same list, each item unchanged apart from a new `contentCheck`:
    {"problem": "ok", "states_unlisted_fact": 0.05, "names_other_venue": 0.02,
     "theme_present": 0.93, "order_flip": false,       # order_flip only when known
     "needs_review": false, "review_reasons": []}      # "error" only when no answer came back

needs_review is true when the choice is not `ok`, when states_unlisted_fact or
names_other_venue is at least 0.5, or when theme_present is below 0.5 (the one
question where a low value is the bad sign). An answer that is missing also sets
needs_review: an unlabelled draft is not a clean one. If the schedule row has no
theme, the theme_present question is not asked and cannot flag the draft.

Offline answers are a JSON object keyed by the draft's key:
    {"2026-10-06_tight-end": {"problem": "ok", "states_unlisted_fact": 0.05,
                              "names_other_venue": 0.02, "theme_present": 0.93,
                              "order_flip": false}}
A value may also be a full Jev answer object ({"noul": 0.2} / {"choice": "ok"}).
"""

from __future__ import annotations

import argparse
import copy
import json
import math
import sys
from pathlib import Path

LABEL = "poker_event_copy"
JEV_TOOLS_DIR = "C:/jev-tools"

# A noul at or above this is "high". Used both ways: a high states_unlisted_fact
# or names_other_venue is bad, a low (below this) theme_present is bad.
REVIEW_AT = 0.5

# Venue styles, from the draft-poker-event-content automation prompt.
VENUE_STYLES = {
    "Tight End": "cinematic adult nightlife, confident, lightly flirty",
    "Wild Corgi": "a charismatic corgi, playful, clever, whimsical but adult, never childish",
}

QUESTION_IDS = ("problem", "states_unlisted_fact", "names_other_venue", "theme_present")


class NoAnswer(Exception):
    """No model answer is available for a draft (offline gap or Jev failure)."""


# --- small helpers ------------------------------------------------------------

def _s(value) -> str:
    """JS String(value || '')."""
    return "" if not value else str(value)


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


# --- the questions ------------------------------------------------------------
# Plain dicts in the same shape the client's noul() and choice() builders return,
# so the wording can be checked without importing the client.

Q_PROBLEM = "What is the main problem with this event title and description, judged against the schedule row"
Q_PROBLEM_CRITERIA = {
    "ok": "no problem; it matches the schedule and the venue's style",
    "off_theme": "it does not reflect the night's theme",
    "wrong_venue_voice": "its tone fits the other venue's style rather than this one",
    "invented_fact": "it states a time, prize, buy-in, format or guest that the schedule row does not contain",
    "tone_breach": "it is childish, crude or otherwise unsuitable for a public adult bar audience",
    "other": "some other problem",
}
Q_UNLISTED = "The description states a time, prize amount, buy-in, game format or guest name that does not appear in the schedule row"
Q_OTHER_VENUE = "The title or description names a bar or venue other than the one in the schedule row"
Q_THEME = "The title or description clearly reflects the theme given in the schedule row"


def _schedule(item: dict) -> dict:
    schedule = item.get("schedule")
    return schedule if isinstance(schedule, dict) else {}


def _has_theme(item: dict) -> bool:
    return bool(_s(_schedule(item).get("theme")).strip())


def build_questions(item: dict) -> dict:
    questions = {
        "problem": {"type": "choice", "instructions": Q_PROBLEM, "criteria": dict(Q_PROBLEM_CRITERIA)},
        "states_unlisted_fact": {"type": "noul", "instructions": Q_UNLISTED},
        "names_other_venue": {"type": "noul", "instructions": Q_OTHER_VENUE},
    }
    if _has_theme(item):
        questions["theme_present"] = {"type": "noul", "instructions": Q_THEME}
    return questions


def canonical_venue(venue) -> str | None:
    wanted = _s(venue).strip().casefold()
    for name in VENUE_STYLES:
        if name.casefold() == wanted:
            return name
    return None


def venue_style(venue) -> dict:
    """Both venues' styles, so the model can judge 'the other venue's voice'."""
    this = canonical_venue(venue)
    if this is None:
        raise ValueError(f"venue {venue!r} is not one of {', '.join(VENUE_STYLES)}")
    other = next(name for name in VENUE_STYLES if name != this)
    return {
        "this_venue": this,
        "this_venue_style": VENUE_STYLES[this],
        "other_venue": other,
        "other_venue_style": VENUE_STYLES[other],
    }


def build_state(item: dict) -> dict:
    """State = the item (key, schedule, title, description) plus venue_style.

    Built from named fields so a contentCheck left on the item by an earlier run
    never reaches the model.
    """
    return {
        "key": item["key"],
        "schedule": copy.deepcopy(item["schedule"]),
        "title": _s(item.get("title")),
        "description": _s(item.get("description")),
        "venue_style": venue_style(item["schedule"].get("venue")),
    }


# --- answers ------------------------------------------------------------------

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
    """Canned answers keyed by the draft's key."""

    def __init__(self, data: dict):
        if not isinstance(data, dict):
            raise ValueError("offline answers must be a JSON object keyed by draft key")
        self.data = data

    @classmethod
    def from_file(cls, path):
        return cls(json.loads(Path(path).read_text(encoding="utf-8")))

    def __call__(self, item: dict, state: dict, questions: dict) -> dict:
        key = _s(item.get("key"))
        if key not in self.data:
            raise NoAnswer(f"no offline answers for {key}")
        record = self.data[key]
        if not isinstance(record, dict):
            raise NoAnswer(f"offline answers for {key} must be an object")
        answers = {}
        for qid, question in questions.items():
            if qid in record:
                answers[qid] = _as_answer(question["type"], record[qid])
        if "order_flip" in record and "problem" in answers:
            answers["problem"]["order_flip"] = bool(record["order_flip"])
        return answers


def make_live_asker():
    """Build an asker backed by the Jev client. The client is imported here, lazily."""
    if JEV_TOOLS_DIR not in sys.path:
        sys.path.insert(0, JEV_TOOLS_DIR)
    from jev.client import Jev, JevError  # noqa: PLC0415 - deliberately lazy

    jev = Jev()

    def ask(item: dict, state: dict, questions: dict) -> dict:
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


def review_reasons(check: dict, asked_theme: bool = True) -> list[str]:
    """The needs_review rule. An empty list means the draft carries no flag."""
    reasons: list[str] = []

    problem = check.get("problem")
    if problem is None:
        reasons.append("no_answer:problem")
    elif problem != "ok":
        reasons.append(f"problem={problem}")

    for name in ("states_unlisted_fact", "names_other_venue"):
        value = check.get(name)
        if value is None:
            reasons.append(f"no_answer:{name}")
        elif value >= REVIEW_AT:
            reasons.append(f"{name}>={REVIEW_AT}")

    if asked_theme:
        value = check.get("theme_present")
        if value is None:
            reasons.append("no_answer:theme_present")
        elif value < REVIEW_AT:
            reasons.append(f"theme_present<{REVIEW_AT}")

    return reasons


def validate_item(raw, where: str = "draft") -> dict:
    """Check the shape of one draft. Returns it unchanged."""
    if not isinstance(raw, dict):
        raise ValueError(f"{where}: draft must be an object")
    if not _s(raw.get("key")).strip():
        raise ValueError(f"{where}: draft needs a key")
    schedule = raw.get("schedule")
    if not isinstance(schedule, dict):
        raise ValueError(f"{where}: draft needs a schedule object")
    if not _s(schedule.get("date")).strip() or not _s(schedule.get("venue")).strip():
        raise ValueError(f"{where}: schedule needs a date and a venue")
    if canonical_venue(schedule.get("venue")) is None:
        raise ValueError(f"{where}: venue {schedule.get('venue')!r} is not one of {', '.join(VENUE_STYLES)}")
    for field in ("title", "description"):
        if not isinstance(raw.get(field), str):
            raise ValueError(f"{where}: draft needs a text {field}")
    return raw


def content_check(item: dict, asker) -> dict:
    """Ask the questions for one draft and build its contentCheck object."""
    validate_item(item)
    questions = build_questions(item)
    asked_theme = "theme_present" in questions
    error = None
    try:
        answers = asker(item, build_state(item), questions)
    except NoAnswer as exc:
        error = str(exc)
        answers = {}

    problem = _answer_value(answers.get("problem"))
    check = {
        "problem": problem if isinstance(problem, str) else None,
        "states_unlisted_fact": _number(_answer_value(answers.get("states_unlisted_fact"))),
        "names_other_venue": _number(_answer_value(answers.get("names_other_venue"))),
        "theme_present": _number(_answer_value(answers.get("theme_present"))) if asked_theme else None,
    }
    flip = _order_flip(answers)
    if flip is not None:
        check["order_flip"] = flip

    reasons = review_reasons(check, asked_theme)
    check["needs_review"] = bool(reasons)
    check["review_reasons"] = reasons
    if error:
        check["error"] = error
    return check


def check_item(item: dict, asker) -> dict:
    """A copy of the draft with a contentCheck. Title and description are never edited."""
    out = copy.deepcopy(item)
    out["contentCheck"] = content_check(item, asker)
    return out


def check_items(items: list[dict], asker) -> list[dict]:
    return [check_item(item, asker) for item in items]


# --- loading drafts -----------------------------------------------------------

def load_items(path) -> list[dict]:
    data = json.loads(Path(path).read_text(encoding="utf-8"))
    if not isinstance(data, list):
        raise ValueError(f"{path}: expected a JSON list of drafts")
    items = [validate_item(raw, f"{path}[{i}]") for i, raw in enumerate(data)]
    seen: set[str] = set()
    for item in items:
        key = item["key"].strip()
        if key in seen:
            raise ValueError(f"{path}: duplicate key {key!r}")
        seen.add(key)
    return items


# --- frozen expectations ------------------------------------------------------

def load_expectations(path):
    """Return (meta, [(case, item), ...]) with every draft resolved to an item."""
    meta = json.loads(Path(path).read_text(encoding="utf-8"))
    rows = meta["schedule_rows"]
    resolved = []
    for case in meta["cases"]:
        where = f"expectations case {case.get('id')}"
        row_id = case.get("schedule_row")
        if row_id not in rows:
            raise ValueError(f"{where}: unknown schedule_row {row_id!r}")
        draft = case["draft"]
        item = {
            "key": f"expect-{case['id']}",
            "schedule": copy.deepcopy(rows[row_id]),
            "title": draft["title"],
            "description": draft["description"],
        }
        resolved.append((case, validate_item(item, where)))
    return meta, resolved


def _band(value, wanted: str):
    if value is None:
        return False, "no answer"
    ok = value >= REVIEW_AT if wanted == "high" else value < REVIEW_AT
    return ok, f"{value:.2f}"


def score_case(case: dict, check: dict) -> list[tuple[str, bool, str]]:
    """Clauses of one frozen expectation as (clause, met, observed)."""
    expected = case["expected"]
    clauses: list[tuple[str, bool, str]] = []
    if "problem" in expected:
        clauses.append((f"problem={expected['problem']}", check["problem"] == expected["problem"], str(check["problem"])))
    if "needs_review" in expected:
        reasons = ", ".join(check["review_reasons"]) or "none"
        clauses.append(
            (f"needs_review={str(expected['needs_review']).lower()}", check["needs_review"] == expected["needs_review"], reasons)
        )
    for name in ("states_unlisted_fact", "names_other_venue", "theme_present"):
        if name in expected:
            ok, observed = _band(check[name], expected[name])
            clauses.append((f"{name} {expected[name]}", ok, observed))
    return clauses


def run_expectations(path, asker) -> list[dict]:
    meta, resolved = load_expectations(path)
    scored = []
    for case, item in resolved:
        checked = check_item(item, asker)
        clauses = score_case(case, checked["contentCheck"])
        scored.append(
            {
                "id": case["id"],
                "label": case["label"],
                "met": all(ok for _, ok, _ in clauses),
                "clauses": clauses,
                "item": checked,
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


def format_table(items: list[dict]) -> str:
    header = [
        "key", "venue", "title", "problem", "states_unlisted_fact",
        "names_other_venue", "theme_present", "order_flip", "review",
    ]
    rows = ["| " + " | ".join(header) + " |", "|" + "|".join(["---"] * len(header)) + "|"]
    for item in items:
        c = item["contentCheck"]
        review = "REVIEW: " + ", ".join(c["review_reasons"]) if c["needs_review"] else "ok"
        cells = [
            item["key"], item["schedule"].get("venue", ""), item.get("title", ""),
            c["problem"] or "-",
            _fmt_num(c["states_unlisted_fact"]), _fmt_num(c["names_other_venue"]), _fmt_num(c["theme_present"]),
            _fmt_flip(c.get("order_flip")),
            review,
        ]
        rows.append("| " + " | ".join(_cell(x) for x in cells) + " |")
    flagged = sum(1 for item in items if item["contentCheck"]["needs_review"])
    rows.append("")
    rows.append(f"{flagged} of {len(items)} drafts labelled needs_review.")
    return "\n".join(rows)


def format_expectations(scored: list[dict]) -> str:
    lines = ["| # | expectation | met | clauses (observed) |", "|---|---|---|---|"]
    for entry in scored:
        parts = [f"{'ok' if ok else 'NOT MET'}: {name} ({observed})" for name, ok, observed in entry["clauses"]]
        lines.append(f"| {entry['id']} | {_cell(entry['label'])} | {'yes' if entry['met'] else 'no'} | {_cell('; '.join(parts))} |")
    met = sum(1 for entry in scored if entry["met"])
    lines.append("")
    lines.append(f"{met} of {len(scored)} expectations met.")
    return "\n".join(lines)


def _dump(data) -> str:
    return json.dumps(data, indent=2, ensure_ascii=False)


# --- command line -------------------------------------------------------------

def _configure_stdout() -> None:
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")
        except (AttributeError, ValueError):
            pass


def _build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(description="Label drafted event copy against its schedule row. Labels only; never edits copy.")
    p.add_argument("--in", dest="input", metavar="FILE", help="JSON list of {key, schedule, title, description}")
    p.add_argument("--out", metavar="FILE", help="write the labelled JSON here (the only file this tool writes)")
    p.add_argument("--expectations", metavar="FILE", help="run the frozen expectations file and report N met")
    p.add_argument("--offline-answers", metavar="FILE", help="canned Jev answers keyed by draft key; no network call is made")
    p.add_argument("--json", action="store_true", help="print machine-readable results to stdout instead of the table")
    return p


def main(argv=None) -> int:
    _configure_stdout()
    parser = _build_parser()
    args = parser.parse_args(argv)

    if args.expectations and args.input:
        parser.error("--expectations cannot be combined with --in")
    if not (args.input or args.expectations):
        parser.error("give --in or --expectations")
    if args.out and args.input and Path(args.out).resolve() == Path(args.input).resolve():
        parser.error("--out must not be the same file as --in")

    try:
        if args.offline_answers:
            asker, source = OfflineAnswers.from_file(args.offline_answers), f"offline answers from {args.offline_answers}"
        else:
            asker, source = make_live_asker(), "Jev (live)"

        if args.expectations:
            scored = run_expectations(args.expectations, asker)
            if args.out:
                Path(args.out).write_text(_dump(scored) + "\n", encoding="utf-8")
            if args.json:
                print(_dump(scored))
            else:
                print(f"Model answers: {source}")
                print()
                print(format_expectations(scored))
                print()
                print(format_table([entry["item"] for entry in scored]))
            return 0

        results = check_items(load_items(args.input), asker)
        if args.out:
            Path(args.out).write_text(_dump(results) + "\n", encoding="utf-8")
    except (OSError, ValueError, json.JSONDecodeError) as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2
    except ImportError as exc:
        print(f"error: could not import the Jev client from {JEV_TOOLS_DIR}: {exc}", file=sys.stderr)
        return 2
    except Exception as exc:  # noqa: BLE001 - JevError at construction (no API key) and the like
        print(f"error: {exc}", file=sys.stderr)
        return 2

    if args.json:
        print(_dump(results))
    else:
        print(f"Model answers: {source}")
        print()
        print(format_table(results))
    for item in results:
        if item["contentCheck"].get("error"):
            print(f"warning: {item['key']}: {item['contentCheck']['error']}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())

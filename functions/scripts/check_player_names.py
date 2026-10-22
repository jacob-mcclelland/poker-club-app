#!/usr/bin/env python3
"""Build a review list of roster player names for the admin.

A player name is free text typed by whoever is at the kiosk, the RSVP page or
the public landing page. addPlayer, checkin, rsvp and emailSignup in
functions/index.js store it after checking only that it is not empty, and the
name then shows on the public leaderboard, the kiosk list and the TV timer.
This tool reads an offline export of the `players` collection and lists the
names an admin should look at.

It is a review list and nothing more. It never rejects, hides, renames or
blocks anyone, no Cloud Function calls it, and its exit code never reports
"bad names": exit 0 means it ran, exit 2 means an input error. It looks at each
name on its own and never compares names with each other. It writes nothing
except stdout, stderr and the optional --out file, and keeps no log.

    python functions/scripts/check_player_names.py --names export.json
    python functions/scripts/check_player_names.py --names export.json --no-jev
    python functions/scripts/check_player_names.py --names export.json --json --out review.json
    python functions/scripts/check_player_names.py --expectations functions/scripts/player_names_expectations.json

Add --offline-answers answers.json to use canned answers instead of calling
Jev, or --no-jev to run only the deterministic pre-checks.

Input is a JSON list of
    {"id": "<players doc id>", "name": "<players.name as stored>",
     "source": "add", "createdAt": "2026-09-30T19:02:11Z"}
`id` is required and unique, `name` is a required string (empty is allowed, the
pre-checks catch it), `source` is a required non-empty string shown to the admin
and never sent anywhere, and `createdAt` is optional and shown but never sent.
Any other field is ignored and never sent.

Offline answers are a JSON object keyed by record id:
    {"expect-1": {"name_kind": "plausible_person_name", "offensive_content": 0.03,
                  "order_flip": false}}
A value may also be a full Jev answer object ({"choice": "x", "probabilities":
{...}} / {"noul": 0.8}).

Exports and --out files belong in %TEMP% or the session scratchpad. The path
guard refuses (exit 2) any --names or --out path inside the git working tree
that holds this script, or inside a folder named OneDrive.
"""

from __future__ import annotations

import argparse
import json
import math
import os
import re
import sys
import unicodedata
from pathlib import Path

LABEL = "poker_player_names"
JEV_TOOLS_DIR = "C:/jev-tools"

# Review threshold: offensive_content at or above this puts a name on the list.
# A starting guess, not a calibrated probability.
REVIEW_AT = 0.5

# Longer than this (after normalising) gets the too_long flag. A guess.
MAX_LENGTH = 40

# This many digits or more reads as a phone number rather than a test entry.
PHONE_MIN_DIGITS = 7

RECORD_FIELDS = ("id", "name", "source", "createdAt")

PLAUSIBLE = "plausible_person_name"
JOKE = "joke_or_offensive"
SPAM = "spam_or_url_or_email"
TEST = "test_entry"
OTHER = "other"


class NoAnswer(Exception):
    """No model answer is available for a record (offline gap or Jev failure)."""


# --- normalising and the system-filler skip ------------------------------------

def normalise(text: str) -> str:
    """NFC-normalise, trim, and collapse runs of whitespace to one space."""
    return re.sub(r"\s+", " ", unicodedata.normalize("NFC", text)).strip()


# A placeholder row for an unrecorded player. Never checked, listed or sent.
_FILLER_RE = re.compile(r"unrecorded player( \d+)?", re.IGNORECASE)


def is_filler(text: str) -> bool:
    return bool(_FILLER_RE.fullmatch(text))


# --- deterministic pre-checks, no model ---------------------------------------

# The email pattern emailSignup uses (index.js), unanchored so it matches anywhere.
_EMAIL_RE = re.compile(r"[^\s@]+@[^\s@]+\.[^\s@]+")
_TLDS = (
    "com", "net", "org", "io", "co", "biz", "info", "xyz", "app", "gg", "ly",
    "tv", "shop", "site", "online", "link",
)
_URL_RE = re.compile(
    r"https?://|www\.|[a-z0-9-]{2,}\.(?:" + "|".join(_TLDS) + r")\b",
    re.IGNORECASE,
)
# Characters ignored when deciding whether a name is only digits.
_DIGIT_NOISE_RE = re.compile(r"[ \-().+#/]")


def _digit_run(text: str) -> str:
    return _DIGIT_NOISE_RE.sub("", text)


def precheck_flags(text: str) -> list[str]:
    """Pre-check flags for already-normalised text, in firing order.

    too_short fires for fewer than 2 letters, so it also fires when there are
    none; no_letters or digits_only fires alongside it then, and those decide
    the name without a model.
    """
    flags: list[str] = []
    if _EMAIL_RE.search(text):
        flags.append("email")
    if _URL_RE.search(text):
        flags.append("url")
    run = _digit_run(text)
    digits_only = bool(run) and all(c.isdecimal() for c in run)
    if digits_only:
        flags.append("digits_only")
    letters = sum(1 for c in text if c.isalpha())
    if letters == 0 and not digits_only:
        flags.append("no_letters")
    if letters < 2:
        flags.append("too_short")
    if len(text) > MAX_LENGTH:
        flags.append("too_long")
    return flags


def precheck_kind(text: str, flags: list[str]):
    """The kind code assigns without asking Jev, or None when Jev must be asked."""
    if "email" in flags or "url" in flags:
        return SPAM
    if "digits_only" in flags:
        return SPAM if len(_digit_run(text)) >= PHONE_MIN_DIGITS else TEST
    if "no_letters" in flags:
        return TEST
    return None


# --- Jev questions ------------------------------------------------------------
# Plain dicts in the same shape the client's noul() and choice() builders return,
# so the wording can be checked without importing the client.

CONTEXT = (
    "Text a person typed into the player name box when signing in, RSVPing or joining "
    "the email list for a bar's weekly poker league. The name is shown on a public "
    "leaderboard and on a TV in the bar."
)
Q_KIND = "What kind of entry is the text in the name field"
Q_KIND_CRITERIA = {
    PLAUSIBLE: (
        "a name a real person could go by at a bar poker night: a full name, a first name alone, "
        "a first name with a last initial, initials, a hyphenated or accented name, or a friendly "
        "nickname such as Lucky Lou"
    ),
    JOKE: "a joke, prank or pun name, an insult, or text containing profanity, a slur or sexual content",
    SPAM: "an advertisement or promotion, a web address, an email address, a phone number, or a plug for a social media account",
    TEST: "a test or placeholder entry, such as test, asdf, xxx, player 1, guest, or random keyboard mashing",
    OTHER: "something else, such as a team or business name, or a message typed into the name box",
}
Q_OFFENSIVE = "The text contains profanity, a slur, sexual content or an insult, in any spelling or language"


def build_questions() -> dict:
    return {
        "name_kind": {"type": "choice", "instructions": Q_KIND, "criteria": dict(Q_KIND_CRITERIA)},
        "offensive_content": {"type": "noul", "instructions": Q_OFFENSIVE},
    }


def build_state(text: str) -> dict:
    """Exactly two keys. No id, source, createdAt or anything else goes to Jev."""
    return {"context": CONTEXT, "name": text}


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


def _probability(answer, key: str):
    """One option's probability from a choice answer (Jev's debiased probabilities)."""
    if isinstance(answer, dict):
        probabilities = answer.get("probabilities")
        if isinstance(probabilities, dict):
            return _number(probabilities.get(key))
    return None


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
    """Canned answers keyed by record id."""

    def __init__(self, data: dict):
        if not isinstance(data, dict):
            raise ValueError("offline answers must be a JSON object keyed by record id")
        self.data = data

    @classmethod
    def from_file(cls, path):
        return cls(json.loads(Path(path).read_text(encoding="utf-8-sig")))

    def __call__(self, record: dict, state: dict, questions: dict) -> dict:
        key = str(record.get("id"))
        if key not in self.data:
            raise NoAnswer(f"no offline answers for {key}")
        answers_for_record = self.data[key]
        if not isinstance(answers_for_record, dict):
            raise NoAnswer(f"offline answers for {key} must be an object")
        answers = {}
        for qid, question in questions.items():
            if qid in answers_for_record:
                answers[qid] = _as_answer(question["type"], answers_for_record[qid])
        if "order_flip" in answers_for_record and "name_kind" in answers:
            answers["name_kind"]["order_flip"] = bool(answers_for_record["order_flip"])
        return answers


def make_live_asker():
    """Build an asker backed by the Jev client. The client is imported here, lazily."""
    if JEV_TOOLS_DIR not in sys.path:
        sys.path.insert(0, JEV_TOOLS_DIR)
    from jev.client import Jev, JevError  # noqa: PLC0415 - deliberately lazy

    jev = Jev()

    def ask(record: dict, state: dict, questions: dict) -> dict:
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


def _scrub(message: str, *names: str) -> str:
    """Keep a player's name out of a warning even if an error message echoes it."""
    for name in sorted({n for n in names if len(n) >= 3}, key=len, reverse=True):
        message = re.sub(re.escape(name), "<name>", message, flags=re.IGNORECASE)
    return message[:200]


def check_record(record: dict, asker=None) -> dict:
    """Pre-checks, then (when asker is given and code has not decided) the Jev questions."""
    stored = record["name"]
    text = normalise(stored)
    flags = precheck_flags(text)
    kind = precheck_kind(text, flags)
    asked = asker is not None and kind is None
    result = {
        "id": record["id"],
        "source": record["source"],
        "name": stored,
        "createdAt": record.get("createdAt"),
        "kind": kind,
        "decided_by": "precheck" if kind is not None else None,
        "prechecks": flags,
        "jev_asked": asked,
        "offensive_content": None,
        "plausible_score": None,
        "order_flip": None,
        "error": None,
    }
    reasons = list(flags)

    if asked:
        try:
            answers = asker(record, build_state(text), build_questions())
        except NoAnswer as exc:
            result["error"] = _scrub(str(exc), stored, text)
            answers = {}
        if not isinstance(answers, dict):
            answers = {}

        kind_answer = answers.get("name_kind")
        kind_value = _answer_value(kind_answer)
        offensive = _number(_answer_value(answers.get("offensive_content")))
        result["kind"] = kind_value if isinstance(kind_value, str) and kind_value else None
        result["decided_by"] = "jev" if result["kind"] is not None else None
        result["offensive_content"] = offensive
        result["plausible_score"] = _probability(kind_answer, PLAUSIBLE)
        result["order_flip"] = _order_flip(answers)

        if result["kind"] is None or offensive is None:
            reasons.append("no_answer")
        if result["kind"] is not None and result["kind"] != PLAUSIBLE:
            reasons.append(f"name_kind={result['kind']}")
        if offensive is not None and offensive >= REVIEW_AT:
            reasons.append(f"offensive_content>={REVIEW_AT}")

    result["review_reasons"] = reasons
    result["flagged"] = bool(reasons)
    return result


def check_records(records: list[dict], asker=None):
    """Check every record on its own. Returns (results, system fillers skipped)."""
    results: list[dict] = []
    skipped = 0
    for record in records:
        if is_filler(normalise(record["name"])):
            skipped += 1
            continue
        results.append(check_record(record, asker))
    return results, skipped


# --- ordering the review list -------------------------------------------------

def review_group(result: dict) -> int:
    """1 joke or offensive, 2 spam, 3 test, 4 other, 5 no answer, 6 plausible but flagged for length."""
    kind = result["kind"]
    offensive = result["offensive_content"]
    if kind == JOKE or (offensive is not None and offensive >= REVIEW_AT):
        return 1
    if "no_answer" in result["review_reasons"]:
        return 5
    if kind == SPAM:
        return 2
    if kind == TEST:
        return 3
    if kind is not None and kind != PLAUSIBLE:
        return 4
    return 6


def sort_for_review(results: list[dict]) -> list[dict]:
    """Flagged records by group; within a group lowest plausible score first, missing last, then id."""
    def key(result: dict):
        score = result["plausible_score"]
        return (review_group(result), score is None, 0.0 if score is None else score, result["id"])

    return sorted((r for r in results if r["flagged"]), key=key)


# --- loading the export -------------------------------------------------------

def validate_record(raw, where: str) -> dict:
    """Check the shape of one record and return a copy holding only the known fields."""
    if not isinstance(raw, dict):
        raise ValueError(f"{where}: record must be an object")
    record_id = raw.get("id")
    if not isinstance(record_id, str) or not record_id.strip():
        raise ValueError(f"{where}: record needs a text id")
    if not isinstance(raw.get("name"), str):
        raise ValueError(f"{where}: record needs a text name")
    source = raw.get("source")
    if not isinstance(source, str) or not source.strip():
        raise ValueError(f"{where}: record needs a source")
    created = raw.get("createdAt")
    if created is not None and not isinstance(created, str):
        raise ValueError(f"{where}: createdAt must be a text timestamp")
    return {"id": record_id, "name": raw["name"], "source": source, "createdAt": created}


def load_records(path):
    """Return (records, names of fields outside the export format that were ignored)."""
    data = json.loads(Path(path).read_text(encoding="utf-8-sig"))
    if not isinstance(data, list):
        raise ValueError(f"{path}: expected a JSON list of records")
    records: list[dict] = []
    seen: set[str] = set()
    extras: set[str] = set()
    for index, raw in enumerate(data):
        record = validate_record(raw, f"{path}[{index}]")
        if record["id"] in seen:
            raise ValueError(f"{path}: duplicate id {record['id']!r}")
        seen.add(record["id"])
        extras.update(k for k in raw if k not in RECORD_FIELDS)
        records.append(record)
    return records, sorted(str(k) for k in extras)


# --- path guard ---------------------------------------------------------------

def find_repo_root(start=None):
    """Walk up from the script's own folder to the first folder holding .git."""
    here = Path(start if start is not None else __file__).resolve()
    if not here.is_dir():
        here = here.parent
    for folder in (here, *here.parents):
        if (folder / ".git").exists():
            return folder
    return None


def _is_inside(child: Path, parent: Path) -> bool:
    child_n = os.path.normcase(str(child))
    parent_n = os.path.normcase(str(parent))
    try:
        return os.path.commonpath([child_n, parent_n]) == parent_n
    except ValueError:  # different drives
        return False


def path_problem(path, option: str, script_dir=None):
    """Why a --names or --out path is refused, or None when it is fine."""
    given = Path(path)
    candidates = (given.resolve(), Path(os.path.abspath(given)))
    root = find_repo_root(script_dir)
    if root is not None:
        for candidate in candidates:
            if _is_inside(candidate, root):
                return (
                    f"{option} path {path} is inside the git working tree {root}; "
                    "keep exports and output in %TEMP% or the scratchpad"
                )
    for candidate in candidates:
        for folder in candidate.parents:
            name = folder.name.lower()
            if name == "onedrive" or name.startswith("onedrive - "):
                return (
                    f"{option} path {path} is inside a OneDrive folder; "
                    "keep exports and output in %TEMP% or the scratchpad"
                )
    return None


def guard_path(path, option: str, script_dir=None) -> None:
    problem = path_problem(path, option, script_dir)
    if problem:
        raise ValueError(problem)


# --- frozen expectations ------------------------------------------------------

def load_expectations(path):
    """Return (meta, [(case, record), ...]). The file holds only synthetic names."""
    meta = json.loads(Path(path).read_text(encoding="utf-8-sig"))
    resolved = []
    seen: set[str] = set()
    for case in meta["cases"]:
        where = f"expectations case {case.get('id')}"
        record = validate_record(case["record"], where)
        if record["id"] != case["id"]:
            raise ValueError(f"{where}: record id {record['id']!r} must match the case id")
        if record["id"] in seen:
            raise ValueError(f"{where}: duplicate case id")
        seen.add(record["id"])
        resolved.append((case, record))
    return meta, resolved


def _band(value, wanted: str):
    if value is None:
        return False, "no answer"
    ok = value >= REVIEW_AT if wanted == "high" else value < REVIEW_AT
    return ok, f"{value:.2f}"


def score_case(case: dict, result: dict) -> list[tuple[str, bool, str]]:
    """Clauses of one frozen expectation as (clause, met, observed)."""
    expected = case["expected"]
    clauses: list[tuple[str, bool, str]] = []
    if "name_kind" in expected:
        clauses.append((f"name_kind={expected['name_kind']}", result["kind"] == expected["name_kind"], str(result["kind"])))
    if "flagged" in expected:
        reasons = ", ".join(result["review_reasons"]) or "none"
        clauses.append((f"flagged={str(expected['flagged']).lower()}", result["flagged"] == expected["flagged"], reasons))
    if "prechecks" in expected:
        wanted = ", ".join(expected["prechecks"]) or "none"
        clauses.append((f"prechecks={wanted}", result["prechecks"] == expected["prechecks"], ", ".join(result["prechecks"]) or "none"))
    if "jev_asked" in expected:
        clauses.append((f"jev_asked={str(expected['jev_asked']).lower()}", result["jev_asked"] == expected["jev_asked"], str(result["jev_asked"]).lower()))
    if "decided_by" in expected:
        clauses.append((f"decided_by={expected['decided_by']}", result["decided_by"] == expected["decided_by"], str(result["decided_by"])))
    if "offensive_content" in expected:
        ok, observed = _band(result["offensive_content"], expected["offensive_content"])
        clauses.append((f"offensive_content {expected['offensive_content']}", ok, observed))
    return clauses


def case_findings(case: dict, result: dict) -> list[str]:
    """Observed answers the case does not freeze. A finding to report, never a miss."""
    expected = case["expected"]
    findings: list[str] = []
    if "offensive_content" not in expected and result["offensive_content"] is not None:
        findings.append(f"offensive_content {result['offensive_content']:.2f}")
    if result["order_flip"] is True:
        findings.append("order_flip yes")
    return findings


def run_expectations(path, asker=None) -> list[dict]:
    meta, resolved = load_expectations(path)
    scored = []
    for case, record in resolved:
        result = check_record(record, asker)
        clauses = score_case(case, result)
        scored.append(
            {
                "id": case["id"],
                "label": case["label"],
                "met": all(ok for _, ok, _ in clauses),
                "clauses": clauses,
                "findings": case_findings(case, result),
                "result": result,
            }
        )
    return scored


# --- output -------------------------------------------------------------------

def _cell(text) -> str:
    """One table cell. Control characters are shown as \\xNN so a name cannot drive the terminal."""
    shown = "".join(
        f"\\x{ord(ch):02x}" if unicodedata.category(ch) == "Cc" else ch for ch in str(text)
    )
    return shown.replace("|", "\\|")


def _fmt_num(value) -> str:
    return "-" if value is None else f"{value:.2f}"


def _fmt_flip(value) -> str:
    return "-" if value is None else ("yes" if value else "no")


def format_review_table(results: list[dict], skipped: int = 0) -> str:
    header = [
        "#", "id", "source", "name", "kind", "decided by", "pre-check flags",
        "offensive_content", "plausible score", "order_flip", "reasons",
    ]
    rows = ["| " + " | ".join(header) + " |", "|" + "|".join(["---"] * len(header)) + "|"]
    listed = sort_for_review(results)
    for number, r in enumerate(listed, start=1):
        cells = [
            number, r["id"], r["source"], r["name"], r["kind"] or "-", r["decided_by"] or "-",
            ", ".join(r["prechecks"]) or "-",
            _fmt_num(r["offensive_content"]), _fmt_num(r["plausible_score"]), _fmt_flip(r["order_flip"]),
            ", ".join(r["review_reasons"]) or "-",
        ]
        rows.append("| " + " | ".join(_cell(c) for c in cells) + " |")
    rows.append("")
    rows.append(
        f"{len(listed)} of {len(results)} names on the review list. "
        f"{skipped} system fillers skipped. This list changes nothing: the admin decides."
    )
    return "\n".join(rows)


def format_expectations(scored: list[dict]) -> str:
    lines = ["| # | expectation | met | clauses (observed) | findings (not frozen) |", "|---|---|---|---|---|"]
    for item in scored:
        parts = [f"{'ok' if ok else 'NOT MET'}: {name} ({observed})" for name, ok, observed in item["clauses"]]
        findings = "; ".join(item["findings"]) or "-"
        lines.append(
            f"| {item['id']} | {_cell(item['label'])} | {'yes' if item['met'] else 'no'} "
            f"| {_cell('; '.join(parts))} | {_cell(findings)} |"
        )
    met = sum(1 for item in scored if item["met"])
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
    p = argparse.ArgumentParser(
        description="List roster player names an admin should look at. A review list only: it never rejects or edits a name."
    )
    p.add_argument("--names", metavar="FILE", help="JSON list of {id, name, source, createdAt} (an export kept in %%TEMP%%)")
    p.add_argument("--expectations", metavar="FILE", help="run the frozen expectations file and report N met")
    p.add_argument("--offline-answers", metavar="FILE", help="canned Jev answers keyed by record id; no network call is made")
    p.add_argument("--no-jev", action="store_true", help="pre-checks only")
    p.add_argument("--json", action="store_true", help="print every record as machine-readable JSON instead of the review table")
    p.add_argument("--out", metavar="FILE", help="also write every record as JSON here (outside the repo and OneDrive)")
    return p


def main(argv=None) -> int:
    _configure_stdout()
    parser = _build_parser()
    args = parser.parse_args(argv)

    if args.offline_answers and args.no_jev:
        parser.error("--offline-answers and --no-jev cannot be combined")
    if args.expectations and args.names:
        parser.error("--expectations cannot be combined with --names")
    if not (args.names or args.expectations):
        parser.error("give --names or --expectations")
    if args.out and args.names and Path(args.out).resolve() == Path(args.names).resolve():
        parser.error("--out must not be the same file as --names")

    extras: list[str] = []
    try:
        # --expectations is exempt from the guard: it holds only synthetic names.
        if args.names:
            guard_path(args.names, "--names")
        if args.out:
            guard_path(args.out, "--out")

        if args.no_jev:
            asker, source = None, "pre-checks only"
        elif args.offline_answers:
            asker, source = OfflineAnswers.from_file(args.offline_answers), f"offline answers from {args.offline_answers}"
        else:
            asker, source = make_live_asker(), "Jev (live)"

        if args.expectations:
            scored = run_expectations(args.expectations, asker)
            results = [item["result"] for item in scored]
            skipped = 0
            payload = scored
        else:
            records, extras = load_records(args.names)
            results, skipped = check_records(records, asker)
            payload = results

        if args.out:
            Path(args.out).write_text(_dump(payload) + "\n", encoding="utf-8")
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
        print(_dump(payload))
        if skipped:
            print(f"note: {skipped} system fillers skipped.", file=sys.stderr)
    else:
        print(f"Model answers: {source}")
        print()
        if args.expectations:
            print(format_expectations(scored))
            print()
        print(format_review_table(results, skipped))
    if extras:
        print(
            f"warning: fields outside {', '.join(RECORD_FIELDS)} were ignored and not sent: {', '.join(extras)}",
            file=sys.stderr,
        )
    for r in results:
        if r["jev_asked"] and (r["error"] is not None):
            detail = f" ({r['error']})" if r["error"] else ""
            print(f"warning: {r['id']}: no model answer{detail}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())

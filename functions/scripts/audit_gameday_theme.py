#!/usr/bin/env python3
"""Audit game-day theme and gear copy before it feeds the 10:00 announcement.

Brief 17 (P5, P6) with Amendments 1 and 2. A schedule row's type, theme and
gear go straight into the morning feed post and push (buildGamedayAnnouncement
in functions/index.js) with no review in between. This audit shows, for every
row, the exact sentence the current code renders, how the theme and the gear
phrase were chosen, the reasons behind the row's status, and the status the owner acts
on:

    read           nothing blocks the row; the owner still reads the line
    needs_signoff  the owner signs off on the exact sentence (or fixes the row): gear
                   from the sport or generic fallback, invisible characters,
                   letters that pass for Latin ones, an emoji-only theme, a
                   type name plus a suffix
    blocked        filler or a type echo is printed, a Regular night falls
                   back to REGULAR, the gear is filler, or a run-time check
                   against the renderer or csc.gear_description disagrees; no
                   signoff clears it, only a fixed row does

Themes and gear are normalized before the filler and echo checks (NFKC, format
characters and blank letters removed, whitespace collapsed, then everything
but letters and digits removed), so "T.B.D.", " T B D " and "tbd." count as
filler and "BigStack" counts as a type echo on any night. TBD, TBA, TBC and
N/A also count as whole words inside a longer value ("Theme TBD"), as do "to
be determined", "to be announced" and "to be confirmed", and, in gear only,
"none". Batch and template leftovers ("XXX", "Test", "Week 3", "%s") are
filler too. Invisible characters are shown as <U+XXXX> so the terminal shows
what will be sent.

It is local and deterministic: no Jev, no network, no Firestore, no writes.
The sentence comes from brief 5's mirror, check_schedule_copy.py, imported as a
module so that its current functions, map and sport list are read at call time.

    python functions/scripts/audit_gameday_theme.py --entries PATH [--approved-themes FILE]
    python functions/scripts/audit_gameday_theme.py --expectations functions/scripts/gameday_theme_expectations.json

Entries: a non-empty UTF-8 JSON array of objects with exactly four string
fields, type, theme, gearDescription and announcementNote, where type is
exactly Regular, Championship or Big Stack. Approved themes: a JSON array of
objects with exactly three string fields, type, theme and expected_sentence.
An approval applies only when all three match a row exactly, only to a
needs_signoff row.

Exit codes: 0 when every row is read; 1 when any row is blocked or needs
signoff, or a frozen case does not match; 2 on malformed or empty input,
before any report is printed.

Run it before season entry and before each scheduled send, then run brief 5's
sentence and note check (check_schedule_copy.py). It cannot cancel a send that
is already deployed.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
import unicodedata
from pathlib import Path

_HERE = Path(__file__).resolve().parent
if str(_HERE) not in sys.path:
    sys.path.insert(0, str(_HERE))

# Rule 1: import the module itself and read csc.sanitize_theme,
# csc.gear_description, csc.render_push_sentence, csc._trim, csc.GEAR_MAP and
# csc.SPORT_WORDS through it at call time. render_push_sentence calls
# gear_description and sanitize_theme through its own module globals, so names
# copied into this module would hide a change from the rendered sentence.
import check_schedule_copy as csc  # noqa: E402

ENTRY_FIELDS = ("type", "theme", "gearDescription", "announcementNote")
APPROVAL_FIELDS = ("type", "theme", "expected_sentence")
EVENT_TYPES = ("Regular", "Championship", "Big Stack")
SPECIAL_TYPES = frozenset({"Championship", "Big Stack"})

THEME_STATES = ("real", "empty", "filler", "type_echo")
GEAR_SOURCES = ("custom", "exact_map", "sport_substring", "generic", "suppressed")
STATUSES = ("blocked", "needs_signoff", "read")
# The per-row fields a frozen case pins exactly.
RESULT_FIELDS = ("theme_state", "gear_source", "code_theme_is_real", "status", "sentence")

# Filler values. Each is compared through theme_key, so case, punctuation,
# spacing and look-alike widths do not matter, and "?", "-" and "--" all
# become the empty key, which is filler.
FILLER_THEMES = frozenset({
    "tbd", "tba", "n/a", "none", "placeholder", "theme", "coming soon",
    "-", "--", "tbc", "?", "undefined", "null", "na",
    "test", "lorem ipsum", "tk", "nan", "[object Object]",
})
PLACEHOLDER_WORD = "placeholder"

# Amendment 2 item 1. Filler values that also count as whole words inside a
# longer value (only while they are in FILLER_THEMES), the gear-only word, and
# phrases that count anywhere.
INNER_FILLER_WORDS = ("tbd", "tba", "tbc", "n/a")
GEAR_ONLY_FILLER_WORDS = ("none",)
FILLER_PHRASES = ("to be determined", "to be announced", "to be confirmed")
# Slashes NFKC leaves alone but that read as "/" in "N/A".
SLASH_LIKE = (chr(0x2215), chr(0x2044))

# Amendment 2 item 2. Batch placeholders matched against the whole lookup key
# (a run of x, or theme/week/night/event/game followed only by a number), and
# template leftovers matched anywhere in the normalized value.
BATCH_KEY_PATTERNS = (r"x{3,}", r"(?:theme|week|night|event|game)\d+")
TEMPLATE_TOKEN_PATTERN = r"%[sd]|\{\d+\}|\$\{[^}]*\}"

# Amendment 2 item 3. Letters that print as blank space: Hangul fillers and
# the braille blank. They count as hidden characters and are dropped by
# normalize_text like format characters.
BLANK_LETTERS = frozenset(chr(code) for code in (0x115F, 0x1160, 0x3164, 0xFFA0, 0x2800))

# Amendment 2 item 5. Names whose theme-plus-suffix only repeats the kind of
# night; "Poker" because the code's own fallback is "Poker Night".
TYPE_LIKE_NAMES = ("Regular", "Championship", "Big Stack", "Poker")

# The order in which the code picks a gear phrase (index.js:4320-4332).
GEAR_PRECEDENCE = ("custom", "exact_map", "sport_substring")
# Fallback gear sources the owner must sign off on, one exact sentence at a time.
SIGNOFF_SOURCES = frozenset({"sport_substring", "generic"})

# Scripts whose letters can pass for Latin ones when mixed into a Latin value.
LOOKALIKE_SCRIPTS = ("CYRILLIC", "GREEK")

_SEVERITY = {"read": 0, "needs_signoff": 1, "blocked": 2}


class InputError(ValueError):
    """Input the audit refuses to read. The CLI exits 2 before any report."""


# --- loading ------------------------------------------------------------------

def _type_name(value) -> str:
    if isinstance(value, bool):
        return "boolean"
    if value is None:
        return "null"
    return {dict: "object", list: "array", str: "string", int: "number", float: "number"}.get(
        type(value), type(value).__name__
    )


def _reject_duplicate_keys(pairs):
    obj = {}
    for key, value in pairs:
        if key in obj:
            raise InputError(f"duplicate key {key!r}")
        obj[key] = value
    return obj


def _reject_constant(name):
    raise InputError(f"non-standard JSON value {name}")


def read_json(path):
    """Strict UTF-8 JSON. A leading byte order mark is ignored (RFC 8259 allows it)."""
    try:
        raw = Path(path).read_bytes()
    except OSError as exc:
        raise InputError(f"{path}: cannot read file ({exc.strerror or exc})") from exc
    try:
        text = raw.decode("utf-8")
    except UnicodeDecodeError as exc:
        raise InputError(f"{path}: not valid UTF-8 (byte {exc.start})") from exc
    if text.startswith(chr(0xFEFF)):
        text = text[1:]
    try:
        return json.loads(text, object_pairs_hook=_reject_duplicate_keys, parse_constant=_reject_constant)
    except InputError as exc:
        raise InputError(f"{path}: {exc}") from exc
    except json.JSONDecodeError as exc:
        raise InputError(f"{path}: malformed JSON ({exc.msg} at line {exc.lineno} column {exc.colno})") from exc


def _check_exact_string_fields(row, fields, label: str) -> None:
    if not isinstance(row, dict):
        raise InputError(f"{label}: expected an object, got {_type_name(row)}")
    missing = [f for f in fields if f not in row]
    extra = sorted(k for k in row if k not in fields)
    if missing or extra:
        parts = []
        if missing:
            parts.append("missing " + ", ".join(missing))
        if extra:
            parts.append("unexpected " + ", ".join(repr(k) for k in extra))
        raise InputError(f"{label}: needs exactly {', '.join(fields)} ({'; '.join(parts)})")
    for field in fields:
        if not isinstance(row[field], str):
            raise InputError(f"{label}: {field} must be a string, got {_type_name(row[field])}")
    if row["type"] not in EVENT_TYPES:
        raise InputError(f"{label}: unsupported type {row['type']!r}; expected one of {', '.join(EVENT_TYPES)}")


def validate_entries(data, where: str = "entries") -> list[dict]:
    if not isinstance(data, list):
        raise InputError(f"{where}: expected a JSON array of entries, got {_type_name(data)}")
    if not data:
        raise InputError(f"{where}: the array is empty; there is nothing to audit")
    entries = []
    for number, row in enumerate(data, start=1):
        _check_exact_string_fields(row, ENTRY_FIELDS, f"{where} row {number}")
        entries.append({field: row[field] for field in ENTRY_FIELDS})
    return entries


def load_entries(path) -> list[dict]:
    return validate_entries(read_json(path), str(path))


def validate_approvals(data, where: str = "approved themes") -> list[tuple[str, str, str]]:
    if not isinstance(data, list):
        raise InputError(f"{where}: expected a JSON array of approvals, got {_type_name(data)}")
    approvals = []
    for number, row in enumerate(data, start=1):
        _check_exact_string_fields(row, APPROVAL_FIELDS, f"{where} approval {number}")
        approvals.append((row["type"], row["theme"], row["expected_sentence"]))
    return approvals


def load_approvals(path) -> list[tuple[str, str, str]]:
    return validate_approvals(read_json(path), str(path))


# --- text helpers -------------------------------------------------------------

def is_hidden(ch: str) -> bool:
    """A non-printing character, a format character (Cf), a non-ASCII space or a blank letter."""
    return not ch.isprintable() or unicodedata.category(ch) == "Cf" or ch in BLANK_LETTERS


def display(text: str) -> str:
    """Text as the operator's terminal should show it: every hidden character as <U+XXXX>."""
    return "".join(f"<U+{ord(ch):04X}>" if is_hidden(ch) else ch for ch in text)


def _codes(chars) -> list[str]:
    codes = []
    for ch in chars:
        code = f"U+{ord(ch):04X}"
        if code not in codes:
            codes.append(code)
    return codes


def hidden_characters(text: str) -> list[str]:
    """Item 3: code points of hidden characters, in order of first appearance."""
    return _codes(ch for ch in text if is_hidden(ch))


def lookalike_letters(text: str) -> list[str]:
    """Cyrillic or Greek letters mixed into an otherwise Latin value."""
    scripts: dict[str, list[str]] = {}
    for ch in unicodedata.normalize("NFKC", text):
        if ch.isalpha():
            script = unicodedata.name(ch, "?").split(" ", 1)[0]
            scripts.setdefault(script, []).append(ch)
    if "LATIN" not in scripts:
        return []
    return _codes(ch for script in LOOKALIKE_SCRIPTS for ch in scripts.get(script, []))


def normalize_text(text: str) -> str:
    """Item 2: NFKC, format characters and blank letters removed, whitespace collapsed and trimmed."""
    text = unicodedata.normalize("NFKC", text)
    text = "".join(ch for ch in text if unicodedata.category(ch) != "Cf" and ch not in BLANK_LETTERS)
    return " ".join(text.split())


def theme_key(text: str) -> str:
    """The lookup key: normalized, uppercased as the push prints it, casefolded,
    and with everything but letters and digits removed."""
    folded = normalize_text(text).upper().casefold()
    return "".join(ch for ch in folded if ch.isalnum())


def filler_keys() -> set[str]:
    return {theme_key(value) for value in FILLER_THEMES}


def contains_placeholder(text: str) -> bool:
    """Item 2: 'placeholder' anywhere, in any case or bracket."""
    return PLACEHOLDER_WORD in theme_key(text)


def is_type_echo(theme: str, event_type: str) -> bool:
    """Item 2: the theme names an event type, whatever the row's own type."""
    return theme_key(theme) in {theme_key(name) for name in EVENT_TYPES}


def _folded(text: str) -> str:
    """Normalized text in the case the push prints, casefolded, with look-alike slashes as '/'."""
    folded = normalize_text(text).upper().casefold()
    for slash in SLASH_LIKE:
        folded = folded.replace(slash, "/")
    return folded


def _words(text: str) -> list[str]:
    return re.findall(r"[^\W_]+", _folded(text))


def has_filler_word(text: str, field: str = "theme") -> bool:
    """Amendment 2 item 1: a filler word or phrase anywhere, as whole words."""
    words = [w for w in INNER_FILLER_WORDS if w in FILLER_THEMES]
    if field == "gear":
        words += [w for w in GEAR_ONLY_FILLER_WORDS if w in FILLER_THEMES]
    words += list(FILLER_PHRASES)
    alternatives = [r"[\W_]+".join(re.escape(piece) for piece in word.split()) for word in words]
    pattern = r"(?<![^\W_])(?:" + "|".join(alternatives) + r")(?![^\W_])"
    return bool(re.search(pattern, _folded(text)))


def is_batch_placeholder(text: str) -> bool:
    """Amendment 2 item 2: a batch placeholder key, or a template leftover anywhere."""
    key = theme_key(text)
    if any(re.fullmatch(pattern, key) for pattern in BATCH_KEY_PATTERNS):
        return True
    return bool(re.search(TEMPLATE_TOKEN_PATTERN, normalize_text(text), re.IGNORECASE))


def is_emoji_only(text: str) -> bool:
    """Amendment 2 item 5: no letters or digits, but at least one symbol such as an emoji (So)."""
    return theme_key(text) == "" and any(unicodedata.category(ch) == "So" for ch in normalize_text(text))


def filler_kind(text: str, field: str = "theme"):
    """Why a theme or gear value is filler, or None. Emoji-only themes are not filler."""
    if theme_key(text) in filler_keys() and not (field == "theme" and is_emoji_only(text)):
        return "a filler value"
    if is_batch_placeholder(text):
        return "a batch or template placeholder"
    if has_filler_word(text, field):
        return "a filler word or phrase inside the value"
    return None


def is_type_with_suffix(theme: str) -> bool:
    """Amendment 2 item 5: an event type name (or Poker) followed by more words."""
    words = _words(theme)
    for name in TYPE_LIKE_NAMES:
        target = theme_key(name)
        if any("".join(words[:count]) == target for count in range(1, len(words))):
            return True
    return False


# --- classification -----------------------------------------------------------

def classify_theme(entry: dict) -> str:
    """Audit theme_state (brief rule 2 as amended by Amendments 1 and 2)."""
    theme = entry["theme"]
    if not csc._trim(theme):
        return "empty"
    if contains_placeholder(theme) or filler_kind(theme, "theme"):
        return "filler"
    if is_type_echo(theme, entry["type"]):
        return "type_echo"
    return "real"


def has_placeholder_marker(trimmed_theme: str) -> bool:
    """Item 6: the code's trailing marker, derived from the mirror, not a copied regex."""
    return csc.sanitize_theme(trimmed_theme) != trimmed_theme


def code_echoes_type(sanitized_theme: str, event_type: str) -> bool:
    """The code's own echo test: same text as the row's type, ignoring case and edge space."""
    return sanitized_theme.lower() == csc._trim(event_type).lower()


def code_theme_is_real(entry: dict) -> bool:
    """The renderer's own themeIsReal decision (check_schedule_copy.py:125-129).

    TBD and N/A count as real here, exactly as in the code.
    """
    trimmed = csc._trim(entry["theme"])
    sanitized = csc.sanitize_theme(trimmed)
    return bool(sanitized) and not has_placeholder_marker(trimmed) and not code_echoes_type(sanitized, entry["type"])


def theme_for_sentence(entry: dict, code_real: bool) -> str:
    """The theme the renderer hands to gear_description."""
    if code_real:
        return csc.sanitize_theme(csc._trim(entry["theme"]))
    return entry["type"]


def classify_gear(entry: dict, code_real: bool) -> str:
    """Which source supplied the gear phrase, or suppressed when none is printed."""
    if entry["type"] in SPECIAL_TYPES and not code_real:
        return "suppressed"
    theme = theme_for_sentence(entry, code_real).lower()
    found = {
        "custom": bool(csc._trim(entry["gearDescription"])),
        "exact_map": theme in csc.GEAR_MAP,
        "sport_substring": any(word in theme for word in csc.SPORT_WORDS),
    }
    for source in GEAR_PRECEDENCE:
        if found[source]:
            return source
    return "generic"


def decide_status(event_type: str, theme_state: str, code_real: bool, gear_source: str) -> str:
    """Status before signoff (brief rule 3)."""
    if not code_real:
        # The code drops the theme. A special format prints its theme-free line,
        # which is the intended suppression; a Regular night falls back to REGULAR.
        return "read" if event_type in SPECIAL_TYPES else "blocked"
    if theme_state != "real":
        # Filler or a type echo the code prints as a theme, on any type.
        return "blocked"
    if gear_source in SIGNOFF_SOURCES:
        return "needs_signoff"
    return "read"


def base_reason(status: str, theme_state: str, code_real: bool, gear_source: str):
    if status == "blocked":
        if not code_real:
            return "the code drops this theme and the Regular night falls back to REGULAR"
        return f"the code prints this theme, which the audit classes as {theme_state}"
    if status == "needs_signoff":
        return f"gear comes from the {gear_source} fallback: sign off on this exact sentence or add custom gear"
    return None


# --- amendment checks ---------------------------------------------------------

def gear_problems(gear: str) -> list[str]:
    """Item 1: reasons to block a non-blank custom gear phrase."""
    if not csc._trim(gear):
        return []
    visible = "".join(
        ch for ch in unicodedata.normalize("NFKC", gear)
        if unicodedata.category(ch) != "Cf" and not ch.isspace() and ch not in BLANK_LETTERS
    )
    if not visible:
        return ["gear is blank once invisible characters are removed"]
    problems = []
    kind = filler_kind(gear, "gear")
    if kind:
        problems.append(f"gear is {kind}")
    if contains_placeholder(gear):
        problems.append("gear contains 'placeholder'")
    return problems


def renderer_disagreement(entry: dict, code_real: bool, sentence: str):
    """Item 4: does the theme change the rendered sentence, as code_theme_is_real says?"""
    blank_theme = csc.render_push_sentence(dict(entry, theme=""))
    theme_changes = sentence != blank_theme
    if theme_changes == code_real:
        return None
    if theme_changes:
        return "renderer check: the theme changes the rendered sentence, but code_theme_is_real is false"
    return "renderer check: the theme does not change the rendered sentence, but code_theme_is_real is true"


def gear_disagreement(entry: dict, code_real: bool, gear_source: str, sentence: str):
    """Amendment 2 item 4: does csc.gear_description return the phrase gear_source predicts?

    Custom gear must come back as the trimmed gear, an exact-map theme as its
    csc.GEAR_MAP value, a sport theme as a phrase naming that sport, and a
    generic theme as a phrase naming the theme. No template text is copied.
    The phrase must also appear in the rendered sentence.
    """
    if gear_source == "suppressed":
        return None
    theme = theme_for_sentence(entry, code_real)
    phrase = csc.gear_description(dict(entry), theme)
    if not isinstance(phrase, str):
        return "gear phrase check: csc.gear_description did not return text"
    lower = theme.lower()
    map_phrases = set(csc.GEAR_MAP.values())
    if gear_source == "custom":
        expected = phrase == csc._trim(entry["gearDescription"])
    elif gear_source == "exact_map":
        expected = phrase == csc.GEAR_MAP.get(lower)
    elif gear_source == "sport_substring":
        sport = next((word for word in csc.SPORT_WORDS if word in lower), "")
        expected = bool(sport) and sport in phrase and phrase not in map_phrases
    else:
        expected = theme in phrase and phrase not in map_phrases
    if not expected:
        return f"gear phrase check: classified as {gear_source}, but csc.gear_description returns a different phrase"
    if phrase not in sentence:
        return "gear phrase check: the rendered sentence does not contain the phrase csc.gear_description returns"
    return None


def signoff_reasons(entry: dict) -> list[str]:
    """Item 3 and look-alike letters: each makes a row at least needs_signoff."""
    reasons = []
    for field, label in (("theme", "theme"), ("gearDescription", "gear")):
        hidden = hidden_characters(entry[field])
        if hidden:
            reasons.append(f"{label} contains invisible or non-printing characters ({', '.join(hidden)})")
        odd = lookalike_letters(entry[field])
        if odd:
            reasons.append(f"{label} mixes Latin with Cyrillic or Greek letters ({', '.join(odd)}) that can pass for Latin ones")
    return reasons


def printed_theme_reasons(entry: dict, theme_state: str, code_real: bool) -> list[str]:
    """Amendment 2 item 5: a real theme the push prints is at least needs_signoff
    when it is emoji only or an event type name plus a suffix."""
    if theme_state != "real" or not code_real:
        return []
    reasons = []
    if is_emoji_only(entry["theme"]):
        reasons.append("theme has no letters or digits, only symbols such as emoji")
    if is_type_with_suffix(entry["theme"]):
        reasons.append("theme is an event type name plus a suffix, so it may only repeat the kind of night")
    return reasons


def apply_signoff(row: dict, approvals) -> dict:
    """An exact (type, theme, sentence) approval turns needs_signoff into read.

    signoff is "approved" when one applied, "stale" when the type and theme were
    approved for a different sentence, "ignored" when an approval names a row
    that is blocked or needs none, and "-" otherwise.
    """
    exact = (row["type"], row["theme"], row["sentence"]) in approvals
    same_pair = any(t == row["type"] and th == row["theme"] for t, th, _ in approvals)
    if row["status"] == "needs_signoff":
        if exact:
            row["status"] = "read"
            row["signoff"] = "approved"
        elif same_pair:
            row["signoff"] = "stale"
    elif exact or same_pair:
        row["signoff"] = "ignored"
    return row


def audit_entry(entry: dict, approvals=()) -> dict:
    sentence = csc.render_push_sentence(dict(entry))
    state = classify_theme(entry)
    code_real = code_theme_is_real(entry)
    gear = classify_gear(entry, code_real)
    status = decide_status(entry["type"], state, code_real, gear)

    reasons = []
    base = base_reason(status, state, code_real, gear)
    if base:
        reasons.append(base)
    if state == "filler":
        kind = filler_kind(entry["theme"], "theme")
        reasons.append(f"theme is {kind}" if kind else "theme contains 'placeholder'")
    blocking = [f"gear check: {problem}" for problem in gear_problems(entry["gearDescription"])]
    drift = renderer_disagreement(entry, code_real, sentence)
    if drift:
        blocking.append(drift)
    gear_drift = gear_disagreement(entry, code_real, gear, sentence)
    if gear_drift:
        blocking.append(gear_drift)
    raising = signoff_reasons(entry) + printed_theme_reasons(entry, state, code_real)
    if blocking:
        status = "blocked"
    elif raising and _SEVERITY[status] < _SEVERITY["needs_signoff"]:
        status = "needs_signoff"
    reasons += blocking + raising

    notes = []
    if gear == "suppressed" and csc._trim(entry["gearDescription"]):
        notes.append("custom gear was entered, but the special-format line drops it")

    row = {
        "type": entry["type"],
        "theme": entry["theme"],
        "gearDescription": entry["gearDescription"],
        "theme_state": state,
        "gear_source": gear,
        "code_theme_is_real": code_real,
        "status": status,
        "signoff": "-",
        "sentence": sentence,
        "reasons": reasons,
        "notes": notes,
    }
    return apply_signoff(row, approvals)


def audit_entries(entries: list[dict], approvals=()) -> list[dict]:
    approvals = list(approvals)
    return [{"row": number, **audit_entry(entry, approvals)} for number, entry in enumerate(entries, start=1)]


def count_statuses(results: list[dict]) -> dict:
    return {status: sum(1 for r in results if r["status"] == status) for status in STATUSES}


def coverage_problem(results: list[dict], expected_rows: int):
    """None when every input row is reported exactly once, in order."""
    numbers = [r.get("row") for r in results]
    if numbers == list(range(1, expected_rows + 1)):
        return None
    missing = sorted(set(range(1, expected_rows + 1)) - set(numbers))
    detail = f"; missing row {', '.join(str(n) for n in missing)}" if missing else ""
    return f"{expected_rows} rows read but {len(results)} reported{detail}"


def audit_exit_code(results: list[dict]) -> int:
    return 0 if all(r["status"] == "read" for r in results) else 1


# --- output -------------------------------------------------------------------

def _flag(value: bool) -> str:
    return "true" if value else "false"


def _quote(text: str) -> str:
    return '"' + display(text) + '"'


def format_row(label: str, r: dict) -> str:
    lines = [
        f"{label}: status={r['status']}  type={r['type']}  theme={_quote(r['theme'])}  "
        f"gearDescription={_quote(r['gearDescription'])}",
        f"    theme_state={r['theme_state']}  code_theme_is_real={_flag(r['code_theme_is_real'])}  "
        f"(code: {_flag(r['code_theme_is_real'])}, audit: {r['theme_state']})  "
        f"gear_source={r['gear_source']}  signoff={r['signoff']}",
        f"    sentence: {display(r['sentence'])}",
    ]
    lines += [f"    reason: {display(reason)}" for reason in r.get("reasons", [])]
    lines += [f"    note: {display(note)}" for note in r.get("notes", [])]
    return "\n".join(lines)


def _label_for(results_row: dict, labels: list[str]) -> str:
    number = results_row.get("row")
    if isinstance(number, int) and 1 <= number <= len(labels):
        return labels[number - 1]
    return f"row {number}"


def format_report(results: list[dict], expected_rows: int, labels: list[str], approvals=None) -> str:
    lines = [format_row(_label_for(r, labels), r) for r in results]
    counts = count_statuses(results)
    lines.append("")
    lines.append(
        f"{expected_rows} rows read, {len(results)} rows reported: {counts['read']} read, "
        f"{counts['needs_signoff']} needs_signoff, {counts['blocked']} blocked."
    )
    for status in ("blocked", "needs_signoff"):
        ids = [_label_for(r, labels) for r in results if r["status"] == status]
        lines.append(f"{status}: {', '.join(ids) if ids else 'none'}")
    if approvals is not None:
        applied = sum(1 for r in results if r["signoff"] == "approved")
        stale = sum(1 for r in results if r["signoff"] == "stale")
        lines.append(f"approvals: {len(approvals)} loaded, {applied} applied, {stale} rows with a stale approval.")
    if audit_exit_code(results):
        lines.append("Exit 1: rows above are blocked or need signoff. The owner reads every sentence before any send.")
    else:
        lines.append("Exit 0: every row is read. The owner still reads every sentence before any send.")
    return "\n".join(lines)


# --- frozen cases -------------------------------------------------------------

_EXPECTATION_KEYS = ("case_ids", "expected_totals", "expected_audit_exit", "cases")
_OPTIONAL_EXPECTATION_KEYS = ("description",)
_CASE_KEYS = ("id", "entry", "expected")


def _is_int(value) -> bool:
    return isinstance(value, int) and not isinstance(value, bool)


def _validate_expected(expected, label: str) -> dict:
    if not isinstance(expected, dict) or set(expected) != set(RESULT_FIELDS):
        raise InputError(f"{label}: expected needs exactly {', '.join(RESULT_FIELDS)}")
    if expected["theme_state"] not in THEME_STATES:
        raise InputError(f"{label}: unknown theme_state {expected['theme_state']!r}")
    if expected["gear_source"] not in GEAR_SOURCES:
        raise InputError(f"{label}: unknown gear_source {expected['gear_source']!r}")
    if not isinstance(expected["code_theme_is_real"], bool):
        raise InputError(f"{label}: code_theme_is_real must be true or false")
    if expected["status"] not in STATUSES:
        raise InputError(f"{label}: unknown status {expected['status']!r}")
    if not isinstance(expected["sentence"], str) or not expected["sentence"]:
        raise InputError(f"{label}: sentence must be a non-empty string")
    return dict(expected)


def load_expectations(path) -> dict:
    data = read_json(path)
    where = str(path)
    if not isinstance(data, dict):
        raise InputError(f"{where}: expected a JSON object")
    missing = [k for k in _EXPECTATION_KEYS if k not in data]
    extra = sorted(k for k in data if k not in _EXPECTATION_KEYS + _OPTIONAL_EXPECTATION_KEYS)
    if missing or extra:
        raise InputError(f"{where}: missing {missing or 'nothing'}, unexpected {extra or 'nothing'}")

    case_ids = data["case_ids"]
    if (
        not isinstance(case_ids, list) or not case_ids
        or not all(isinstance(c, str) and c for c in case_ids)
        or len(set(case_ids)) != len(case_ids)
    ):
        raise InputError(f"{where}: case_ids must be a non-empty list of distinct ids")

    totals = data["expected_totals"]
    if not isinstance(totals, dict) or set(totals) != set(STATUSES) or not all(
        _is_int(v) and v >= 0 for v in totals.values()
    ):
        raise InputError(f"{where}: expected_totals needs a count for each of {', '.join(STATUSES)}")

    audit_exit = data["expected_audit_exit"]
    if not _is_int(audit_exit) or audit_exit not in (0, 1):
        raise InputError(f"{where}: expected_audit_exit must be 0 or 1")

    raw_cases = data["cases"]
    if not isinstance(raw_cases, list):
        raise InputError(f"{where}: cases must be an array")
    cases, seen = [], set()
    for number, case in enumerate(raw_cases, start=1):
        label = f"{where} case {number}"
        if not isinstance(case, dict) or set(case) != set(_CASE_KEYS):
            raise InputError(f"{label}: needs exactly {', '.join(_CASE_KEYS)}")
        case_id = case["id"]
        if case_id not in case_ids:
            raise InputError(f"{label}: id {case_id!r} is not listed in case_ids")
        if case_id in seen:
            raise InputError(f"{label}: duplicate id {case_id!r}")
        seen.add(case_id)
        entry = validate_entries([case["entry"]], f"{where} case {case_id}")[0]
        cases.append({"id": case_id, "entry": entry, "expected": _validate_expected(case["expected"], f"{where} case {case_id}")})

    return {
        "case_ids": list(case_ids),
        "expected_totals": dict(totals),
        "expected_audit_exit": audit_exit,
        "cases": cases,
    }


def _same(actual, expected) -> bool:
    return type(actual) is type(expected) and actual == expected


def _show(value) -> str:
    if isinstance(value, bool):
        return _flag(value)
    return _quote(value) if isinstance(value, str) else str(value)


def run_expectations(spec: dict) -> dict:
    cases = spec["cases"]
    results = audit_entries([case["entry"] for case in cases])
    by_row = {r.get("row"): r for r in results}

    outcomes = {}
    for number, case in enumerate(cases, start=1):
        result = by_row.get(number)
        if result is None:
            problems = ["missing from the audit output"]
        else:
            problems = [
                f"{field}: expected {_show(case['expected'][field])}, got {_show(result.get(field))}"
                for field in RESULT_FIELDS
                if not _same(result.get(field), case["expected"][field])
            ]
        outcomes[case["id"]] = {"id": case["id"], "problems": problems, "result": result}
    for case_id in spec["case_ids"]:
        if case_id not in outcomes:
            outcomes[case_id] = {"id": case_id, "problems": ["missing from the expectations file"], "result": None}

    ordered = [outcomes[case_id] for case_id in spec["case_ids"]]
    matched = sum(1 for outcome in ordered if not outcome["problems"])
    totals = count_statuses(results)
    audit_exit = audit_exit_code(results)
    coverage = coverage_problem(results, len(cases))
    ok = (
        matched == len(spec["case_ids"])
        and coverage is None
        and totals == spec["expected_totals"]
        and audit_exit == spec["expected_audit_exit"]
    )
    return {
        "outcomes": ordered,
        "matched": matched,
        "total": len(spec["case_ids"]),
        "results": results,
        "labels": [case["id"] for case in cases],
        "coverage": coverage,
        "totals": totals,
        "expected_totals": spec["expected_totals"],
        "audit_exit": audit_exit,
        "expected_audit_exit": spec["expected_audit_exit"],
        "ok": ok,
    }


def _totals_text(totals: dict) -> str:
    return f"{totals['read']} read, {totals['needs_signoff']} needs_signoff, {totals['blocked']} blocked"


def format_expectations(report: dict, source) -> str:
    labels = report["labels"]
    results = report["results"]
    lines = [f"Frozen cases: {source}", ""]
    lines.extend(format_row(_label_for(r, labels), r) for r in results)
    lines.append("")
    for outcome in report["outcomes"]:
        if outcome["problems"]:
            lines.append(f"{outcome['id']} MISMATCH: " + "; ".join(outcome["problems"]))
        else:
            lines.append(f"{outcome['id']} match")
    lines.append("")
    if report["coverage"]:
        lines.append(f"Coverage FAILED: {report['coverage']}")
    lines.append(f"{report['matched']} of {report['total']} frozen cases match.")
    exit_note = "as frozen" if report["audit_exit"] == report["expected_audit_exit"] else "NOT AS FROZEN"
    totals_note = "as frozen" if report["totals"] == report["expected_totals"] else (
        "NOT AS FROZEN, frozen " + _totals_text(report["expected_totals"])
    )
    lines.append(
        f"Ordinary audit of these same {len(results)} cases: exit {report['audit_exit']} "
        f"(frozen exit {report['expected_audit_exit']}, {exit_note}); {_totals_text(report['totals'])} ({totals_note})."
    )
    for status in ("blocked", "needs_signoff"):
        ids = [_label_for(r, labels) for r in results if r["status"] == status]
        lines.append(f"{status}: {', '.join(ids) if ids else 'none'}")
    return "\n".join(lines)


# --- command line -------------------------------------------------------------

def _configure_stdout() -> None:
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")
        except (AttributeError, ValueError):
            pass


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        description="Audit game-day theme and gear copy (brief 17). Local only: no Jev, no network, no writes."
    )
    p.add_argument("--entries", metavar="PATH",
                   help="non-empty JSON array of {type, theme, gearDescription, announcementNote}")
    p.add_argument("--approved-themes", metavar="FILE",
                   help="JSON array of {type, theme, expected_sentence} approved by J")
    p.add_argument("--expectations", metavar="FILE",
                   help="run the frozen cases and report N of N")
    return p


def main(argv=None) -> int:
    _configure_stdout()
    parser = build_parser()
    args = parser.parse_args(argv)

    if args.expectations:
        if args.entries or args.approved_themes:
            parser.error("--expectations runs the frozen cases alone; do not combine it with --entries or --approved-themes")
        try:
            spec = load_expectations(args.expectations)
        except InputError as exc:
            print(f"error: {exc}", file=sys.stderr)
            return 2
        report = run_expectations(spec)
        print(format_expectations(report, args.expectations))
        return 0 if report["ok"] else 1

    if not args.entries:
        parser.error("give --entries PATH (optionally with --approved-themes FILE) or --expectations FILE")
    try:
        entries = load_entries(args.entries)
        approvals = load_approvals(args.approved_themes) if args.approved_themes else None
    except InputError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2

    results = audit_entries(entries, approvals or [])
    labels = [f"row {n}" for n in range(1, len(entries) + 1)]
    print(format_report(results, len(entries), labels, approvals))
    problem = coverage_problem(results, len(entries))
    if problem:
        print(f"error: coverage: {problem}", file=sys.stderr)
        return 1
    return audit_exit_code(results)


if __name__ == "__main__":
    sys.exit(main())

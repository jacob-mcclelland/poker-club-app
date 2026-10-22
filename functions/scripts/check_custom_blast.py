#!/usr/bin/env python3
"""Pre-send token check for a custom poker email blast (brief 18, amendment 1).

The owner runs this locally on the exact subject and body he intends to paste into
the admin page's custom compose fields (public/admin/comms.html, the
sendCustomBlast path). It matches fixed placeholder and sensitive-cue
patterns only. It takes no recipient list and makes no network, Firestore or
Jev call. A clear result is never approval: The owner still reads the complete
--preview before queueing.

Input (UTF-8; one leading UTF-8 BOM is tolerated):
  --draft PATH                     JSON object with exactly "subject" and "body"
  --subject TEXT --body-file PATH  plain-text body
The subject must be one line, like the page's single-line subject field.

Statuses and exit codes:
  clear_for_human_review  0  no blocking placeholder, every sensitive cue acknowledged
  placeholder_found       1  a blocking placeholder; --ack cannot clear it
  sensitive_review        1  a sensitive cue not yet acknowledged for this draft hash
  input_error             2  unreadable, malformed, blank, oversized or multi-line-subject input

Options:
  --preview  the final email per recipient, every cue with its ack id, and
             draft_sha256. Control and invisible characters show as <U+XXXX>
             marks; the hash covers the real text.
  --json     status, cues and offsets as JSON; never message text. Offsets are
             [start, end] pairs, 0-based, end-exclusive, in Unicode code points
             within the trimmed field.
  --ack HASH:rule@field:line   repeatable; acknowledges one sensitive cue on that exact hash
  --expectations PATH          run the frozen cases; exit 0 only when every case matches
"""
from __future__ import annotations

import argparse
import bisect
import hashlib
import json
import os
import re
import sys
import unicodedata
from dataclasses import dataclass

_HERE = os.path.dirname(os.path.abspath(__file__))
if _HERE not in sys.path:
    sys.path.insert(0, _HERE)

# JS-compatible String.prototype.trim, shared with the schedule checker.
import check_schedule_copy as csc  # noqa: E402

CLEAR = "clear_for_human_review"
PLACEHOLDER = "placeholder_found"
SENSITIVE = "sensitive_review"
INPUT_ERROR = "input_error"
EXIT_CODES = {CLEAR: 0, PLACEHOLDER: 1, SENSITIVE: 1, INPUT_ERROR: 2}

MAX_SUBJECT = 200
MAX_BODY = 10_000
DRAFT_KEYS = ("subject", "body")
FIELDS = ("subject", "body")

# The page wraps each body as `Hey ${firstName}!\n\n${body}\n\n<signature>`
# (public/admin/comms.html:494-496). Preview only; never scanned.
GREETING = "Hey <FIRST_NAME>!"
SIGNATURE = "\u2014 All-In Poker Club"  # the page's signature starts with U+2014


# ---------------------------------------------------------------- patterns

def _words(words, flags=re.IGNORECASE):
    return re.compile(r"\b(?:" + "|".join(words) + r")\b", flags)


CAPS_WORDS = ("TBD", "TODO", "TK", "PLACEHOLDER")
EDITORIAL_VERBS = ("add", "insert", "replace", "fill", "update", "write",
                   "paste", "check", "confirm", "link")
PAYMENT_TERMS = ("payment", "paid", "pay", "dues", "owe", "owes", "balance",
                 "refund", "invoice")
ACCOUNT_TERMS = ("account", "login", "password", "credential")
INDIVIDUAL_TERMS = ("member", "individual", "person", "player")
TOPIC_TERMS = ("standing", "standings", "rank", "qualified", "qualification",
               "discipline", "suspension", "health", "injury", "attendance",
               "absent")

_CAPS_RE = _words(CAPS_WORDS, flags=0)
_CAPS_ANY_CASE_RE = _words(CAPS_WORDS)
_BRACKET_CHAR_RE = re.compile(r"[\[\]{}]")
_LOREM_RE = re.compile(r"\blorem\s+ipsum\b", re.IGNORECASE)
_INSERT_HERE_RE = re.compile(r"\binsert\b.{0,40}?\bhere\b", re.IGNORECASE)
_ANGLE_RE = re.compile(r"<\s*[A-Za-z][A-Za-z0-9_ -]*\s*>")
_BRACE_RE = re.compile(r"\{\{?\s*[A-Za-z][A-Za-z0-9_ -]*\s*\}\}?")
_EDITORIAL_LEAD_RE = re.compile(
    r"\[\s*(?:" + "|".join(EDITORIAL_VERBS) + r")\b", re.IGNORECASE)
# Amendment 2, item 1: a typed or pasted-back preview mark looks exactly like
# a real hidden character in the preview, so it blocks.
_PREVIEW_MARK_RE = re.compile(r"<U\+[0-9A-F]{4,6}>", re.IGNORECASE)
# Amendment 2, item 3: a *|...|* merge tag, which this page never resolves.
_MERGE_TAG_RE = re.compile(r"\*\|.*?\|\*", re.DOTALL)

_EMAIL_RE = re.compile(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}")
# Separator run between phone digit groups (amendment 1, item 2): 1 to 3 of any
# whitespace, period, hyphen, U+2010 to U+2015, U+2212, or a parenthesis.
_PHONE_SEP = r"[\s.()\-\u2010-\u2015\u2212]"
_PHONE_RE = re.compile(r"(?<!\d)(?:\+1" + _PHONE_SEP + r"{0,3})?\(?\d{3}"
                       + _PHONE_SEP + r"{1,3}\d{3}" + _PHONE_SEP + r"{1,3}\d{4}(?!\d)")
_LONG_DIGIT_RE = re.compile(r"\d{9,}")
_LINK_RE = re.compile(r"https?://\S+|www\.\S+", re.IGNORECASE)
_PAYMENT_RE = _words(PAYMENT_TERMS)
_ACCOUNT_RE = _words(ACCOUNT_TERMS)
_INDIVIDUAL_RE = _words(INDIVIDUAL_TERMS)
_TOPIC_RE = _words(TOPIC_TERMS)
_WORD_PLACEHOLDER_RE = re.compile(r"\bplaceholder\b", re.IGNORECASE)

_LINE_BREAK_RE = re.compile(r"\r\n|\r|\n")
_ACK_RE = re.compile(r"([0-9a-f]{64}):([a-z_]+)@(subject|body):([1-9][0-9]*)")

# Preview only (amendment 1, item 3): every control character except tab and
# LF (a CR not followed by LF included), soft hyphen, zero-width characters,
# word joiner, BOM, and the bidi embedding, override and isolate controls.
# Amendment 2, item 4 adds U+2028, U+2029 and the tag block U+E0000 to U+E007F
# here; visible() also marks every other format character (category Cf).
_INVISIBLE_RE = re.compile(
    r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f\u00ad\u200b-\u200d\u2060\ufeff"
    r"\u202a-\u202e\u2066-\u2069\N{LINE SEPARATOR}\N{PARAGRAPH SEPARATOR}"
    r"\U000e0000-\U000e007f]|\r(?!\n)")


# --------------------------------------------------------------- detectors
# A detector takes a line or a whole field (see the rule scopes below) and
# returns (start, end) spans within the text it was given.

def _spans(regex, text):
    return [m.span() for m in regex.finditer(text)]


def _matcher(regex):
    return lambda text: _spans(regex, text)


def _bracket_pairs(text):
    """Every closed [...] and {...} pair in a field, nested or not, across lines.

    Returns (opener, start, end) with end exclusive. An unclosed opener or a
    stray closer is not a pair.
    """
    open_at = {"[": [], "{": []}
    opener_of = {"]": "[", "}": "{"}
    pairs = []
    for match in _BRACKET_CHAR_RE.finditer(text):
        char = match.group()
        if char in open_at:
            open_at[char].append(match.start())
        elif open_at[opener_of[char]]:
            pairs.append((opener_of[char], open_at[opener_of[char]].pop(), match.end()))
    return pairs


def _covered(text):
    """covered[i] is True when position i lies inside a closed bracket pair."""
    depth = [0] * (len(text) + 1)
    for _, start, end in _bracket_pairs(text):
        depth[start] += 1
        depth[end] -= 1
    covered, running = [], 0
    for delta in depth[:-1]:
        running += delta
        covered.append(running > 0)
    return covered


def _caps_placeholder(text):
    covered = _covered(text)
    return _spans(_CAPS_RE, text) + [m.span() for m in _CAPS_ANY_CASE_RE.finditer(text)
                                     if covered[m.start()]]


def _square_editorial(text):
    return [(start, end) for opener, start, end in _bracket_pairs(text)
            if opener == "[" and _EDITORIAL_LEAD_RE.match(text, start)]


def _individual_detail(line):
    if _PAYMENT_RE.search(line) or _TOPIC_RE.search(line):
        return _spans(_INDIVIDUAL_RE, line)
    return []


def _word_placeholder(text):
    covered = _covered(text)
    return [m.span() for m in _WORD_PLACEHOLDER_RE.finditer(text)
            if not m.group().isupper() and not covered[m.start()]]


def _bracket_span(text, blocking):
    """[...] and {...} pairs that no blocking match overlaps.

    Amendment 1, item 5 (square pairs); amendment 2, item 2 adds brace pairs.
    """
    return [(start, end) for _opener, start, end in _bracket_pairs(text)
            if not any(s < end and start < e for s, e in blocking)]


# Scope "field" runs on the whole trimmed field, so a match may cross line
# breaks and its cue takes the line where the match starts (amendment 1,
# item 1). Scope "line" runs on one line at a time.
BLOCKING_RULES = (
    ("caps_placeholder", "field", _caps_placeholder),
    ("lorem_ipsum", "line", _matcher(_LOREM_RE)),
    ("insert_here", "line", _matcher(_INSERT_HERE_RE)),
    ("angle_token", "field", _matcher(_ANGLE_RE)),
    ("brace_token", "field", _matcher(_BRACE_RE)),
    ("square_editorial", "field", _square_editorial),
    ("preview_mark", "field", _matcher(_PREVIEW_MARK_RE)),
    ("merge_tag", "field", _matcher(_MERGE_TAG_RE)),
)
SENSITIVE_RULES = (
    ("email_address", "line", _matcher(_EMAIL_RE)),
    ("phone_shape", "field", _matcher(_PHONE_RE)),  # "any whitespace" includes a line break
    ("long_digit_run", "line", _matcher(_LONG_DIGIT_RE)),
    ("link", "line", _matcher(_LINK_RE)),
    ("payment_term", "line", _matcher(_PAYMENT_RE)),
    ("account_term", "line", _matcher(_ACCOUNT_RE)),
    ("individual_detail", "line", _individual_detail),
    ("sensitive_topic", "line", _matcher(_TOPIC_RE)),
    ("word_placeholder", "field", _word_placeholder),
    ("bracket_span", "field", None),  # needs the blocking matches; see _field_matches
)
BLOCKING_IDS = frozenset(rule for rule, _, _ in BLOCKING_RULES)
SENSITIVE_IDS = frozenset(rule for rule, _, _ in SENSITIVE_RULES)
RULES = ([(rule, "blocking", scope, detect) for rule, scope, detect in BLOCKING_RULES]
         + [(rule, "sensitive", scope, detect) for rule, scope, detect in SENSITIVE_RULES])
RULE_ORDER = {rule: index for index, (rule, *_) in enumerate(RULES)}


# ------------------------------------------------------------------- model

class InputError(Exception):
    """Input rejected. The message is fixed text and never quotes input."""


@dataclass
class Cue:
    field: str
    line: int
    rule: str
    kind: str          # "blocking" or "sensitive"
    offsets: list      # [[start, end], ...] code points within the trimmed field
    acknowledged: bool = False

    @property
    def cue_id(self):
        return f"{self.rule}@{self.field}:{self.line}"


@dataclass
class Result:
    status: str
    cues: list
    ignored_acks: list
    draft_sha256: str = ""
    subject: str = ""
    body: str = ""
    reason: str = ""

    @property
    def exit_code(self):
        return EXIT_CODES[self.status]


# ------------------------------------------------------------------- check

def _lines(text):
    """Yield (1-based line number, field offset, line text). Breaks: CRLF, CR, LF."""
    start = 0
    number = 1
    for brk in _LINE_BREAK_RE.finditer(text):
        yield number, start, text[start:brk.start()]
        start = brk.end()
        number += 1
    yield number, start, text[start:]


def _field_matches(text):
    """{rule id: [(start, end), ...]} in field offsets for one trimmed field."""
    lines = list(_lines(text))
    matches = {}
    for rule, _kind, scope, detect in RULES:
        if detect is None:
            continue
        if scope == "field":
            matches[rule] = detect(text)
        else:
            matches[rule] = [(start + a, start + b)
                             for _, start, line in lines for a, b in detect(line)]
    blocking = [span for rule in BLOCKING_IDS for span in matches[rule]]
    matches["bracket_span"] = _bracket_span(text, blocking)
    return matches


def scan(subject, body):
    """Every distinct (field, line, rule id) cue in the trimmed fields."""
    cues = []
    for field, text in zip(FIELDS, (subject, body)):
        line_starts = [start for _, start, _ in _lines(text)]
        grouped = {}
        for rule, spans in _field_matches(text).items():
            for start, end in sorted(set(spans)):
                line = bisect.bisect_right(line_starts, start)
                grouped.setdefault((line, rule), []).append([start, end])
        for line, rule in sorted(grouped, key=lambda key: (key[0], RULE_ORDER[key[1]])):
            kind = "blocking" if rule in BLOCKING_IDS else "sensitive"
            cues.append(Cue(field, line, rule, kind, grouped[(line, rule)]))
    return cues


def draft_sha256(subject, body):
    return hashlib.sha256((subject + "\0" + body).encode("utf-8")).hexdigest()


def validate_fields(subject, body):
    """Trim both fields like the page does, then enforce the input limits."""
    if not isinstance(subject, str) or not isinstance(body, str):
        raise InputError("subject and body must be strings")
    subject, body = csc._trim(subject), csc._trim(body)
    for name, text, limit in (("subject", subject, MAX_SUBJECT),
                              ("body", body, MAX_BODY)):
        if not text:
            raise InputError(f"{name} is blank after trim")
        if "\0" in text:
            raise InputError(f"{name} contains a NUL character")
        try:
            text.encode("utf-8")
        except UnicodeEncodeError:
            raise InputError(f"{name} is not valid Unicode text") from None
        if len(text) > limit:
            raise InputError(f"{name} is over {limit} Unicode code points")
    if "\r" in subject or "\n" in subject:
        raise InputError("subject contains a line break; the page's subject field is one line")
    return subject, body


def apply_acks(cues, digest, acks):
    """Mark acknowledged sensitive cues; return the ignored acknowledgements."""
    by_id = {cue.cue_id: cue for cue in cues}
    ignored = []
    for index, raw in enumerate(acks, 1):
        match = _ACK_RE.fullmatch(raw)
        if not match:
            ignored.append({"index": index, "reason": "malformed acknowledgement"})
            continue
        ack_hash, rule, field, line = match.groups()
        cue_id = f"{rule}@{field}:{line}"
        if ack_hash != digest:
            reason = "hash is not this draft's draft_sha256"
        elif rule in BLOCKING_IDS:
            reason = "blocking placeholders cannot be acknowledged"
        elif rule not in SENSITIVE_IDS:
            reason = "unknown rule id"
        elif cue_id not in by_id:
            reason = "no such cue on this draft"
        else:
            by_id[cue_id].acknowledged = True
            continue
        ignored.append({"index": index, "cue": cue_id, "reason": reason})
    return ignored


def check_draft(subject, body, acks=()):
    try:
        subject, body = validate_fields(subject, body)
    except InputError as exc:
        return Result(INPUT_ERROR, [], [], reason=str(exc))
    digest = draft_sha256(subject, body)
    cues = scan(subject, body)
    ignored = apply_acks(cues, digest, acks)
    if any(cue.kind == "blocking" for cue in cues):
        status = PLACEHOLDER
    elif any(cue.kind == "sensitive" and not cue.acknowledged for cue in cues):
        status = SENSITIVE
    else:
        status = CLEAR
    return Result(status, cues, ignored, digest, subject, body)


# ------------------------------------------------------------------- input

def _is_recipient_key(key):
    lowered = key.lower()
    return lowered in ("to", "cc", "bcc", "email", "emails") or "recipient" in lowered


def read_utf8_file(path):
    try:
        with open(path, "rb") as handle:
            raw = handle.read()
    except OSError:
        raise InputError("cannot read input file") from None
    if raw.startswith((b"\xff\xfe", b"\xfe\xff")):
        raise InputError("input file is UTF-16; save it as UTF-8")
    if b"\x00" in raw:
        raise InputError("input file contains NUL bytes (likely UTF-16); save it as UTF-8")
    try:
        text = raw.decode("utf-8")
    except UnicodeDecodeError:
        raise InputError("input file is not valid UTF-8") from None
    return text[1:] if text.startswith("\ufeff") else text


def _no_duplicate_keys(pairs):
    keys = [key for key, _ in pairs]
    if len(keys) != len(set(keys)):
        raise InputError("draft JSON repeats a key")
    return dict(pairs)


def load_draft_json(path):
    text = read_utf8_file(path)
    try:
        data = json.loads(text, object_pairs_hook=_no_duplicate_keys)
    except InputError:
        raise
    except (ValueError, RecursionError):
        raise InputError("draft file is not valid JSON") from None
    if not isinstance(data, dict):
        raise InputError("draft JSON must be an object with exactly subject and body")
    if any(_is_recipient_key(key) for key in data):
        raise InputError("recipient fields are not accepted; the checker takes no recipient list")
    if set(data) != set(DRAFT_KEYS):
        raise InputError("draft JSON must have exactly the keys subject and body")
    if not all(isinstance(data[key], str) for key in DRAFT_KEYS):
        raise InputError("subject and body must be strings")
    return data["subject"], data["body"]


# ------------------------------------------------------------------ output

def _mark(char):
    return f"<U+{ord(char):04X}>"


def visible(text):
    """Preview only: show control and invisible characters as <U+XXXX> marks."""
    text = _INVISIBLE_RE.sub(lambda m: _mark(m.group()), text)
    return "".join(_mark(char) if unicodedata.category(char) == "Cf" else char
                   for char in text)


def _ignored_text(entry):
    text = f"ignored ack #{entry['index']}: {entry['reason']}"
    return text + (f" ({entry['cue']})" if "cue" in entry else "")


def render_default(result):
    out = [f"status: {result.status}"]
    if result.status == INPUT_ERROR:
        out.append(f"reason: {result.reason}")
    for cue in result.cues:
        out.append(f"{cue.field}:{cue.line} {cue.rule}"
                   + (" acknowledged" if cue.acknowledged else ""))
    out += [_ignored_text(entry) for entry in result.ignored_acks]
    return "\n".join(out)


def render_json(result):
    payload = {"status": result.status, "exit_code": result.exit_code}
    if result.status == INPUT_ERROR:
        payload["reason"] = result.reason
    else:
        payload["cues"] = [
            {"field": cue.field, "line": cue.line, "rule": cue.rule,
             "kind": cue.kind, "acknowledged": cue.acknowledged,
             "offsets": cue.offsets}
            for cue in result.cues]
        payload["ignored_acks"] = result.ignored_acks
    return json.dumps(payload, indent=2)


def render_preview(result):
    subject, body = visible(result.subject), visible(result.body)
    out = [
        "===== preview: final email for each recipient =====",
        f"Subject: {subject}",
        "",
        GREETING,
        "",
        body,
        "",
        SIGNATURE,
        "===== end of preview =====",
        "<FIRST_NAME> stands in for each recipient's first name. The page adds"
        " the greeting and signature; neither is scanned.",
    ]
    if (subject, body) != (result.subject, result.body):
        out.append("<U+XXXX> marks a control or invisible character. The email carries"
                   " the real character, and draft_sha256 covers it.")
    out += [f"status: {result.status}", "cues:" if result.cues else "cues: none"]
    for cue in result.cues:
        label = f"  {cue.field}:{cue.line} {cue.rule}"
        if cue.kind == "blocking":
            out.append(f"{label}  blocking; edit the draft (cannot be acknowledged)")
        elif cue.acknowledged:
            out.append(f"{label}  acknowledged")
        else:
            out.append(f"{label}  ack id: {result.draft_sha256}:{cue.cue_id}")
    out += [_ignored_text(entry) for entry in result.ignored_acks]
    out.append(f"draft_sha256: {result.draft_sha256}")
    out.append("Read the complete email above before queueing. A clear status is not approval.")
    return "\n".join(out)


# ------------------------------------------------------------ expectations

def _valid_case(case):
    return (isinstance(case, dict)
            and all(isinstance(case.get(k), str) for k in ("id", "subject", "body", "status"))
            and isinstance(case.get("exit"), int)
            and isinstance(case.get("cues"), list)
            and all(isinstance(p, list) and len(p) == 2 and all(isinstance(x, str) for x in p)
                    for p in case["cues"]))


def _cue_list(pairs):
    return "[" + ", ".join(f"{field}:{rule}" for field, rule in pairs) + "]"


def run_expectations(path):
    try:
        cases = json.loads(read_utf8_file(path))["cases"]
        if not isinstance(cases, list) or not cases or not all(map(_valid_case, cases)):
            raise ValueError
    except (InputError, ValueError, KeyError, TypeError):
        print(f"status: {INPUT_ERROR}")
        print("reason: expectations file is unreadable or malformed")
        return EXIT_CODES[INPUT_ERROR]
    matched = 0
    for case in cases:
        result = check_draft(case["subject"], case["body"])
        got = sorted([cue.field, cue.rule] for cue in result.cues)
        want = sorted(list(pair) for pair in case["cues"])
        problems = []
        if result.status != case["status"]:
            problems.append(f"status {result.status}, expected {case['status']}")
        if got != want:
            problems.append(f"cues {_cue_list(got)}, expected {_cue_list(want)}")
        if result.exit_code != case["exit"]:
            problems.append(f"exit {result.exit_code}, expected {case['exit']}")
        if problems:
            print(f"{case['id']} FAIL: " + "; ".join(problems))
        else:
            matched += 1
            print(f"{case['id']} pass: {result.status}, exit {result.exit_code}, cues {_cue_list(got)}")
    print(f"{matched} of {len(cases)} cases match")
    return 0 if matched == len(cases) else 1


# --------------------------------------------------------------------- cli

class _ArgParser(argparse.ArgumentParser):
    def error(self, message):
        # argparse would echo argument values; report fixed text instead.
        raise InputError("invalid command-line arguments; run with --help")


def _build_parser():
    parser = _ArgParser(
        prog="check_custom_blast.py", allow_abbrev=False,
        description="Local pre-send token check for a custom email blast. "
                    "A clear result still requires reading the full --preview.")
    parser.add_argument("--draft", metavar="PATH",
                        help="UTF-8 JSON object with exactly subject and body")
    parser.add_argument("--subject", metavar="TEXT", help="subject text (one line)")
    parser.add_argument("--body-file", metavar="PATH", help="UTF-8 plain-text body")
    parser.add_argument("--ack", action="append", default=[], metavar="HASH:rule@field:line",
                        help="acknowledge one sensitive cue on this exact draft hash (repeatable)")
    parser.add_argument("--preview", action="store_true",
                        help="print the final email, every cue with its ack id, and draft_sha256")
    parser.add_argument("--json", action="store_true",
                        help="print status, cues and offsets as JSON (no message text)")
    parser.add_argument("--expectations", metavar="PATH",
                        help="run the frozen expectation cases and exit")
    return parser


def _load_input(args):
    if args.draft is not None:
        if args.subject is not None or args.body_file is not None:
            raise InputError("use --draft, or --subject with --body-file, not both")
        return load_draft_json(args.draft)
    if args.subject is None or args.body_file is None:
        raise InputError("give --draft PATH, or both --subject TEXT and --body-file PATH")
    return args.subject, read_utf8_file(args.body_file)


def main(argv=None):
    json_mode = preview = False
    try:
        args = _build_parser().parse_args(argv)
        if args.expectations is not None:
            if (args.draft is not None or args.subject is not None or args.body_file is not None
                    or args.ack or args.preview or args.json):
                raise InputError("--expectations takes no other option")
            return run_expectations(args.expectations)
        if args.preview and args.json:
            raise InputError("--preview and --json cannot be combined")
        json_mode, preview = args.json, args.preview
        subject, body = _load_input(args)
        result = check_draft(subject, body, args.ack)
    except InputError as exc:
        result = Result(INPUT_ERROR, [], [], reason=str(exc))
    if json_mode:
        print(render_json(result))
    elif preview and result.status != INPUT_ERROR:
        print(render_preview(result))
    else:
        print(render_default(result))
    return result.exit_code


if __name__ == "__main__":
    if hasattr(sys.stdout, "reconfigure"):
        # UTF-8 so the preview (including the page's em dash signature) is
        # byte-faithful when piped; the Windows console already uses UTF-8.
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.exit(main())

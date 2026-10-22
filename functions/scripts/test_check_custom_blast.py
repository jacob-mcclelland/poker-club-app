"""Tests for check_custom_blast.py (brief 18 pre-send check). Invented drafts only.

Network, subprocess (node), os process launchers (os.system, os.spawn*,
os.exec*, os.startfile, os.popen) and Firestore access are patched to raise
for the whole module, so any attempt to reach them fails a test. Amendment 1
and 2 cases use the review's drafts (REVIEW_BUILD_18_2026-10-03.md) verbatim;
the only name in any draft is the invented "Quill".

Run from the app root:
  python -m unittest discover -s functions/scripts -p test_check_custom_blast.py -v
"""
import ast
import hashlib
import io
import json
import os
import re
import socket
import subprocess
import sys
import tempfile
import types
import unittest
import urllib.request
from contextlib import redirect_stderr, redirect_stdout
from unittest import mock

HERE = os.path.dirname(os.path.abspath(__file__))
if HERE not in sys.path:
    sys.path.insert(0, HERE)

import check_custom_blast as ccb  # noqa: E402
import check_schedule_copy as csc  # noqa: E402

EXPECTATIONS = os.path.join(HERE, "custom_blast_expectations.json")
OWN_FILES = ("check_custom_blast.py", "custom_blast_expectations.json",
             "test_check_custom_blast.py")

CLEAR = "clear_for_human_review"
PLACEHOLDER = "placeholder_found"
SENSITIVE = "sensitive_review"
INPUT_ERROR = "input_error"

# Brief 18 frozen table, copied here independently of the JSON file so that
# editing the expectations file cannot weaken the frozen outcomes.
FROZEN = [
    ("C1", "Friday game update", "Doors open at seven. See you at the tables.", CLEAR, [], 0),
    ("C2", "TBD schedule", "See you at the tables.", PLACEHOLDER,
     [("subject", "caps_placeholder")], 1),
    ("C3", "Game update", "Please RSVP by [add date].", PLACEHOLDER,
     [("body", "square_editorial")], 1),
    ("C4", "Game update", "Hello {{first_name}}, your seat is ready.", PLACEHOLDER,
     [("body", "brace_token")], 1),
    ("C5", "Game update", "Insert PLACEHOLDER here before sending.", PLACEHOLDER,
     [("body", "caps_placeholder"), ("body", "insert_here")], 1),
    ("C6", "Game update", "Visit https://club.example for details.", SENSITIVE,
     [("body", "link")], 1),
    ("C7", "Game update", "A member owes $120 in dues.", SENSITIVE,
     [("body", "individual_detail"), ("body", "payment_term")], 1),
    ("C8", "Game update", "We will explain what a placeholder means in the editor.", SENSITIVE,
     [("body", "word_placeholder")], 1),
    ("C9", "Game update", "This message is for the full league. Thanks for playing.", CLEAR, [], 0),
    ("C10", "Game update", "Placeholder text follows.", SENSITIVE,
     [("body", "word_placeholder")], 1),
    ("R1", "Game update", "Hey ${firstName}! Doors open at seven.", PLACEHOLDER,
     [("body", "brace_token")], 1),
    ("R2", "Schedule", "Fri, Oct 9 at TBD.", PLACEHOLDER,
     [("body", "caps_placeholder")], 1),
    ("R3", "Championship",
     "Congratulations, you have qualified for the Championship. "
     "Please RSVP at https://club.example/rsvp",
     SENSITIVE, [("body", "link"), ("body", "sensitive_topic")], 1),
]
FROZEN_IDS = [case[0] for case in FROZEN]

SENTINEL = "Zephyrquill"  # invented word; must never appear in non-preview output
SENT_CLAIM = re.compile(r"safe_to_send|safe to send|\bsent\b|\bdelivered\b", re.IGNORECASE)
CONTRACT_LINE = re.compile(
    r"status: (clear_for_human_review|placeholder_found|sensitive_review|input_error)"
    r"|(subject|body):[1-9][0-9]* [a-z_]+( acknowledged)?"
    r"|ignored ack #[1-9][0-9]*: .+"
    r"|reason: .+")


# ------------------------------------------------- network and Firestore guard

class _BlockedModule(types.ModuleType):
    def __getattr__(self, name):
        raise RuntimeError(f"{self.__name__} is blocked in these tests")


def _refuse(*args, **kwargs):
    raise RuntimeError("network and subprocess access are blocked in these tests")


_BLOCKED_MODULES = ("firebase_admin", "firebase_admin.firestore",
                    "google.cloud.firestore", "google.cloud.firestore_v1")
_PATCHERS = [
    mock.patch.object(socket.socket, "connect", _refuse),
    mock.patch.object(socket.socket, "connect_ex", _refuse),
    mock.patch.object(socket, "create_connection", _refuse),
    mock.patch.object(socket, "getaddrinfo", _refuse),
    mock.patch.object(urllib.request, "urlopen", _refuse),
    mock.patch.object(subprocess, "Popen", _refuse),
]
# Every os-level process launcher on this platform (amendment 1, item 6).
OS_LAUNCHERS = sorted(name for name in dir(os)
                      if name in ("system", "startfile", "popen")
                      or name.startswith(("spawn", "exec", "posix_spawn")))
_PATCHERS += [mock.patch.object(os, name, _refuse) for name in OS_LAUNCHERS]
_MISSING = object()
_SAVED_MODULES = {}


def setUpModule():
    for patcher in _PATCHERS:
        patcher.start()
    for name in _BLOCKED_MODULES:
        _SAVED_MODULES[name] = sys.modules.get(name, _MISSING)
        sys.modules[name] = _BlockedModule(name)


def tearDownModule():
    for patcher in reversed(_PATCHERS):
        patcher.stop()
    for name, saved in _SAVED_MODULES.items():
        if saved is _MISSING:
            sys.modules.pop(name, None)
        else:
            sys.modules[name] = saved


# ------------------------------------------------------------------ helpers

def run_cli(*argv):
    out, err = io.StringIO(), io.StringIO()
    with redirect_stdout(out), redirect_stderr(err):
        code = ccb.main(list(argv))
    return code, out.getvalue(), err.getvalue()


def cue_keys(result):
    return sorted((cue.field, cue.rule) for cue in result.cues)


def found(body, subject="Game update"):
    """Set of (field, line, rule id) for a draft."""
    return {(cue.field, cue.line, cue.rule) for cue in ccb.check_draft(subject, body).cues}


def body_rules(body):
    return {rule for field, _, rule in found(body) if field == "body"}


class TempDirTestCase(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.tmp = self._tmp.name

    def tearDown(self):
        self._tmp.cleanup()

    def write_bytes(self, name, data):
        path = os.path.join(self.tmp, name)
        with open(path, "wb") as handle:
            handle.write(data)
        return path

    def write_draft(self, payload, name="draft.json"):
        return self.write_bytes(name, json.dumps(payload).encode("utf-8"))

    def cli_draft(self, subject, body, *extra):
        path = self.write_draft({"subject": subject, "body": body})
        return run_cli("--draft", path, *extra)

    def assert_input_error(self, outcome, *absent):
        code, out, err = outcome
        self.assertEqual(code, 2)
        lines = out.splitlines()
        self.assertEqual(lines[0], f"status: {INPUT_ERROR}")
        self.assertTrue(lines[1].startswith("reason: "))
        self.assertEqual(len(lines), 2)
        for text in absent:
            self.assertNotIn(text, out + err)
        return out


# ------------------------------------------------------------- frozen cases

class FrozenCaseTests(TempDirTestCase):
    def test_expectations_file_is_the_brief_table(self):
        with open(EXPECTATIONS, encoding="utf-8") as handle:
            cases = json.load(handle)["cases"]
        got = [(c["id"], c["subject"], c["body"], c["status"],
                sorted(tuple(pair) for pair in c["cues"]), c["exit"]) for c in cases]
        want = [(i, s, b, st, sorted(cues), ex) for i, s, b, st, cues, ex in FROZEN]
        self.assertEqual(got, want)

    def test_frozen_cases(self):
        for case_id, subject, body, status, cues, exit_code in FROZEN:
            with self.subTest(case_id):
                result = ccb.check_draft(subject, body)
                self.assertEqual(result.status, status)
                self.assertEqual(cue_keys(result), sorted(cues))
                self.assertEqual(result.exit_code, exit_code)
                self.assertTrue(all(cue.line == 1 for cue in result.cues))

    def test_frozen_cases_through_the_cli(self):
        for case_id, subject, body, status, cues, exit_code in FROZEN:
            with self.subTest(case_id):
                code, out, err = self.cli_draft(subject, body)
                lines = out.splitlines()
                self.assertEqual(lines[0], f"status: {status}")
                got = sorted((line.split(":")[0], line.split(" ")[1]) for line in lines[1:])
                self.assertEqual(got, sorted(cues))
                self.assertEqual(code, exit_code)
                self.assertEqual(err, "")

    def test_runner_reports_13_of_13(self):
        code, out, _ = run_cli("--expectations", EXPECTATIONS)
        self.assertEqual(code, 0)
        self.assertIn("13 of 13 cases match", out)
        for case_id in FROZEN_IDS:
            self.assertRegex(out, rf"(?m)^{case_id} pass: ")

    def test_always_clear_checker_fails_the_runner(self):
        with mock.patch.object(ccb, "scan", return_value=[]):
            code, out, _ = run_cli("--expectations", EXPECTATIONS)
        self.assertEqual(code, 1)
        self.assertNotIn("13 of 13", out)
        failed = set(re.findall(r"(?m)^(\w+) FAIL:", out))
        self.assertLessEqual({"C2", "C3", "C4", "C5", "C6", "C7", "C8"}, failed)
        self.assertEqual(failed, set(FROZEN_IDS) - {"C1", "C9"})

    def test_runner_compares_status_cues_and_exit(self):
        with open(EXPECTATIONS, encoding="utf-8") as handle:
            data = json.load(handle)
        for key, value in (("status", CLEAR), ("cues", [["body", "payment_term"]]), ("exit", 0)):
            with self.subTest(key):
                tampered = json.loads(json.dumps(data))
                case = next(c for c in tampered["cases"] if c["id"] == "C7")
                case[key] = value
                path = self.write_bytes(f"exp_{key}.json", json.dumps(tampered).encode("utf-8"))
                code, out, _ = run_cli("--expectations", path)
                self.assertEqual(code, 1)
                self.assertRegex(out, r"(?m)^C7 FAIL: ")
                self.assertIn("12 of 13 cases match", out)

    def test_runner_rejects_malformed_expectations(self):
        for raw in (b'{"cases": [{"id": "X"}]}', b'{"cases": []}', b"not json"):
            with self.subTest(raw):
                path = self.write_bytes("bad.json", raw)
                code, out, _ = run_cli("--expectations", path)
                self.assertEqual(code, 2)
                self.assertTrue(out.startswith(f"status: {INPUT_ERROR}"))


# -------------------------------------------------------------------- rules

class RuleTests(unittest.TestCase):
    def assert_rule(self, rule, hits, misses):
        for body in hits:
            with self.subTest(rule=rule, hit=body):
                self.assertIn(rule, body_rules(body))
        for body in misses:
            with self.subTest(rule=rule, miss=body):
                self.assertNotIn(rule, body_rules(body))

    def test_caps_placeholder(self):
        self.assert_rule(
            "caps_placeholder",
            ["Seats TBD.", "TODO: seats", "Photo TK", "PLACEHOLDER", "Seats [tbd].",
             "Seats {todo}.", "[Placeholder]", "{tk}", "[see TODO list]"],
            ["Put this on your todo list.", "Seats tbd soon.", "The XTBD code",
             "TKO night", "a placeholder here"])

    def test_lorem_ipsum(self):
        self.assert_rule("lorem_ipsum", ["Lorem Ipsum dolor", "x lorem  ipsum"],
                         ["lorem dolor", "loremipsum"])

    def test_insert_here_within_one_line_and_40_chars(self):
        self.assert_rule(
            "insert_here",
            ["Insert the venue name here.", "Insert " + "a" * 38 + " here"],
            ["Insert " + "a" * 39 + " here", "Insert the venue\nhere", "Insert the venue\rhere",
             "Insert the venue\r\nhere", "Click here to insert.", "Inserted here"])

    def test_angle_and_brace_tokens(self):
        self.assert_rule("angle_token", ["Dear <first name>,", "< venue >"],
                         ["a < b", "<3 you", "<>"])
        self.assert_rule("brace_token", ["{{ venue }}", "{venue}", "Hey ${firstName}!"],
                         ["{}", "{1}", "{ }"])

    def test_square_editorial_closed_verb_list(self):
        self.assert_rule(
            "square_editorial",
            ["[Link to RSVP form]", "[ insert photo ]", "[CONFIRM time]", "[add date]",
             "[fill]", "[update venue]", "[write intro]", "[paste map]", "[check score]",
             "[replace this]"],
            ["[optional]", "[see note]", "[adding chairs]", "[please insert date]",
             "(add date)", "[add date"])

    def test_email_phone_digits_link(self):
        self.assert_rule("email_address", ["Write to desk.manager@club.example today."],
                         ["desk.manager at club dot example", "@club"])
        self.assert_rule("phone_shape",
                         ["Call 555-201-7788", "(555) 201-7788", "+1 555.201.7788",
                          "+1 (555) 201 7788", "555 201 7788"],
                         ["5552017788", "55-201-7788", "Room 555 201", "1555-201-77889",
                          "555 -- 201 - 7788", "555/201/7788"])
        self.assertIn("long_digit_run", body_rules("5552017788"))
        self.assert_rule("long_digit_run", ["Ref 123456789", "1234567890123"], ["Ref 12345678"])
        self.assert_rule("link",
                         ["https://club.example/a", "http://club.example", "www.club.example",
                          "WWW.CLUB.EXAMPLE"],
                         ["club.example", "http:/club.example"])

    def test_term_cues_are_whole_word_and_case_insensitive(self):
        self.assert_rule("payment_term",
                         ["PAYMENT due", "paid", "Pay at the door", "dues", "owe", "owes",
                          "balance", "refund", "Invoice"],
                         ["payday", "repaid", "payments", "owed"])
        self.assert_rule("account_term", ["Reset your password", "LOGIN", "account", "credential"],
                         ["accounts", "credentials", "logins"])
        self.assert_rule("sensitive_topic",
                         ["standing", "Standings", "rank", "qualified", "qualification",
                          "discipline", "suspension", "health", "injury", "attendance",
                          "ABSENT"],
                         ["ranked", "outstanding", "healthy"])

    def test_individual_detail_needs_a_topic_term_on_the_same_line(self):
        self.assertEqual(body_rules("Each player who qualified"),
                         {"individual_detail", "sensitive_topic"})
        self.assertEqual(body_rules("Player health update"),
                         {"individual_detail", "sensitive_topic"})
        self.assertEqual(body_rules("Every member is welcome."), set())
        self.assertEqual(found("A member\ncovers dues."), {("body", 2, "payment_term")})

    def test_word_placeholder_versus_caps_placeholder(self):
        self.assertEqual(body_rules("a placeholder"), {"word_placeholder"})
        self.assertEqual(body_rules("Placeholder"), {"word_placeholder"})
        self.assertEqual(body_rules("PlaceHolder"), {"word_placeholder"})
        self.assertEqual(body_rules("PLACEHOLDER"), {"caps_placeholder"})
        self.assertEqual(body_rules("[placeholder]"), {"caps_placeholder"})
        self.assertEqual(body_rules("{placeholder}"), {"caps_placeholder", "brace_token"})
        self.assertEqual(body_rules("placeholders"), set())

    def test_overlapping_patterns_each_report(self):
        self.assertEqual(body_rules("{{TODO}}"), {"caps_placeholder", "brace_token"})

    def test_one_cue_per_field_line_and_rule(self):
        cues = ccb.check_draft("Game update",
                               "See https://a.example and https://b.example").cues
        self.assertEqual([(c.field, c.line, c.rule) for c in cues], [("body", 1, "link")])
        self.assertEqual(len(cues[0].offsets), 2)
        self.assertEqual(found("See https://a.example\nand https://b.example"),
                         {("body", 1, "link"), ("body", 2, "link")})

    def test_subject_is_scanned(self):
        self.assertEqual(found("Doors open.", subject="Seats TBD at www.club.example"),
                         {("subject", 1, "caps_placeholder"), ("subject", 1, "link")})

    def test_line_numbers_are_one_based_in_each_trimmed_field(self):
        self.assertEqual(
            found("\n\n  First line\r\nSecond TBD\rThird www.club.example\nFourth",
                  subject="Seats TBD"),
            {("subject", 1, "caps_placeholder"), ("body", 2, "caps_placeholder"),
             ("body", 3, "link")})


# ---------------------------------------------------------- output contract

class OutputContractTests(TempDirTestCase):
    def test_clean_draft_prints_status_only(self):
        code, out, err = self.cli_draft("Friday game update",
                                        "Doors open at seven. See you at the tables.")
        self.assertEqual(code, 0)
        self.assertEqual(out, f"status: {CLEAR}\n")
        self.assertEqual(err, "")

    def test_default_lines_follow_the_contract(self):
        for case_id, subject, body, *_ in FROZEN:
            with self.subTest(case_id):
                _, out, _ = self.cli_draft(subject, body)
                for line in out.splitlines():
                    self.assertRegex(line, CONTRACT_LINE.pattern)
                    self.assertTrue(CONTRACT_LINE.fullmatch(line), line)

    def test_no_output_claims_an_email_was_sent_or_safe(self):
        for case_id, subject, body, *_ in FROZEN:
            for extra in ((), ("--json",), ("--preview",)):
                with self.subTest(case_id, mode=extra):
                    _, out, err = self.cli_draft(subject, body, *extra)
                    self.assertIsNone(SENT_CLAIM.search(out + err))

    def test_default_and_json_output_never_print_message_text(self):
        subject = f"{SENTINEL} notice TBD"
        body = (f"Ring 555-201-7788 or mail desk.manager@club.example, see "
                f"www.club.example/{SENTINEL.lower()}, ref 123456789.\n"
                f"A member owes dues. Lorem ipsum {SENTINEL}.")
        for extra in ((), ("--json",)):
            with self.subTest(extra):
                code, out, err = self.cli_draft(subject, body, *extra)
                self.assertEqual(code, 1)
                for text in (SENTINEL, SENTINEL.lower(), "555-201", "desk.manager", "@",
                             "club.example", "123456789", "owes", "Lorem", "draft_sha256"):
                    self.assertNotIn(text, out + err)

    def test_json_adds_offsets_in_code_points(self):
        _, out, _ = self.cli_draft("Game update", "Visit https://club.example for details.",
                                   "--json")
        payload = json.loads(out)
        self.assertEqual(payload["status"], SENSITIVE)
        self.assertEqual(payload["exit_code"], 1)
        self.assertEqual(payload["cues"], [{"field": "body", "line": 1, "rule": "link",
                                            "kind": "sensitive", "acknowledged": False,
                                            "offsets": [[6, 26]]}])
        self.assertEqual(payload["ignored_acks"], [])

        _, out, _ = self.cli_draft("Game update", "A member owes $120 in dues.", "--json")
        offsets = {c["rule"]: c["offsets"] for c in json.loads(out)["cues"]}
        self.assertEqual(offsets, {"individual_detail": [[2, 8]],
                                   "payment_term": [[9, 13], [22, 26]]})

        body = "\u00e9t\u00e9 line\r\nVisit www.club.example now"
        _, out, _ = self.cli_draft("Game update", body, "--json")
        (cue,) = json.loads(out)["cues"]
        self.assertEqual((cue["line"], cue["offsets"]), (2, [[16, 32]]))
        self.assertEqual(body[16:32], "www.club.example")

    def test_json_input_error_has_reason_only(self):
        path = self.write_bytes("bad.json", f'{{"subject": "{SENTINEL}"'.encode("utf-8"))
        code, out, _ = run_cli("--draft", path, "--json")
        self.assertEqual(code, 2)
        payload = json.loads(out)
        self.assertEqual(set(payload), {"status", "exit_code", "reason"})
        self.assertEqual(payload["status"], INPUT_ERROR)
        self.assertNotIn(SENTINEL, out)


# ------------------------------------------------------------------ preview

class PreviewTests(TempDirTestCase):
    def test_preview_shows_final_email_every_cue_and_hash(self):
        code, out, _ = self.cli_draft("  Game update \n", "\n Visit https://club.example for details. \n",
                                      "--preview")
        self.assertEqual(code, 1)
        digest = hashlib.sha256(
            "Game update\0Visit https://club.example for details.".encode("utf-8")).hexdigest()
        self.assertIn("Subject: Game update\n", out)
        self.assertIn("Hey <FIRST_NAME>!\n\nVisit https://club.example for details.\n\n"
                      "\u2014 All-In Poker Club\n", out)
        self.assertEqual(ccb.SIGNATURE, "\u2014 All-In Poker Club")
        self.assertIn(f"status: {SENSITIVE}", out)
        self.assertIn(f"body:1 link  ack id: {digest}:link@body:1", out)
        self.assertRegex(out, rf"(?m)^draft_sha256: {digest}$")

    def test_greeting_token_is_not_scanned(self):
        code, out, _ = self.cli_draft("Friday game update",
                                      "Doors open at seven. See you at the tables.", "--preview")
        self.assertEqual(code, 0)
        self.assertIn("<FIRST_NAME>", out)
        self.assertIn(f"status: {CLEAR}", out)
        self.assertIn("cues: none", out)
        self.assertNotIn("angle_token", out)

    def test_blocking_cue_has_no_ack_id(self):
        _, out, _ = self.cli_draft("TBD schedule", "See you at the tables.", "--preview")
        self.assertIn("subject:1 caps_placeholder  blocking; edit the draft (cannot be acknowledged)",
                      out)
        self.assertNotIn("ack id:", out)

    def test_preview_and_json_cannot_combine(self):
        self.assert_input_error(self.cli_draft("Game update", "Doors open.", "--preview", "--json"))


# ---------------------------------------------------------- acknowledgement

class AckTests(TempDirTestCase):
    SUBJECT, BODY = "Game update", "A member owes $120 in dues."
    CUES = ("individual_detail@body:1", "payment_term@body:1")

    def setUp(self):
        super().setUp()
        self.draft = self.write_draft({"subject": self.SUBJECT, "body": self.BODY})
        self.hash = ccb.draft_sha256(self.SUBJECT, self.BODY)

    def ack(self, cue_id, digest=None):
        return f"{digest or self.hash}:{cue_id}"

    def run_acks(self, *acks, draft=None):
        argv = ["--draft", draft or self.draft]
        for value in acks:
            argv += ["--ack", value]
        return run_cli(*argv)

    def test_preview_hash_is_sha256_of_trimmed_fields(self):
        _, out, _ = run_cli("--draft", self.draft, "--preview")
        printed = re.search(r"(?m)^draft_sha256: ([0-9a-f]{64})$", out).group(1)
        self.assertEqual(printed, hashlib.sha256(
            b"Game update\x00A member owes $120 in dues.").hexdigest())
        for cue_id in self.CUES:
            self.assertIn(f"ack id: {printed}:{cue_id}", out)

    def test_no_ack_needs_review(self):
        code, out, _ = self.run_acks()
        self.assertEqual((code, out.splitlines()[0]), (1, f"status: {SENSITIVE}"))

    def test_one_ack_is_not_enough(self):
        for cue_id in self.CUES:
            with self.subTest(cue_id):
                code, out, _ = self.run_acks(self.ack(cue_id))
                self.assertEqual((code, out.splitlines()[0]), (1, f"status: {SENSITIVE}"))

    def test_both_acks_on_the_current_hash_clear(self):
        code, out, _ = self.run_acks(*(self.ack(c) for c in self.CUES))
        self.assertEqual(code, 0)
        lines = out.splitlines()
        self.assertEqual(lines[0], f"status: {CLEAR}")
        self.assertEqual(sorted(lines[1:]), ["body:1 individual_detail acknowledged",
                                             "body:1 payment_term acknowledged"])

    def test_hash_from_another_draft_never_clears(self):
        old = ccb.draft_sha256(self.SUBJECT, "A member owes $95 in dues.")
        code, out, _ = self.run_acks(*(self.ack(c, old) for c in self.CUES))
        self.assertEqual((code, out.splitlines()[0]), (1, f"status: {SENSITIVE}"))
        self.assertIn("ignored ack #1: hash is not this draft's draft_sha256 "
                      "(individual_detail@body:1)", out)
        self.assertIn("ignored ack #2: hash is not this draft's draft_sha256 "
                      "(payment_term@body:1)", out)

    def test_any_edit_reopens_every_cue(self):
        edited = self.write_draft({"subject": self.SUBJECT, "body": "A member owes $120 in dues!"},
                                  "edited.json")
        code, out, _ = self.run_acks(*(self.ack(c) for c in self.CUES), draft=edited)
        self.assertEqual((code, out.splitlines()[0]), (1, f"status: {SENSITIVE}"))
        self.assertEqual(out.count("hash is not this draft's draft_sha256"), 2)

    def test_unknown_or_absent_cue_ids_never_clear(self):
        code, out, _ = self.run_acks(
            self.ack("individual_detail@body:1"),
            self.ack("made_up_rule@body:1"),
            self.ack("payment_term@body:2"),
            self.ack("account_term@body:1"),
            self.ack("payment_term@subject:1"))
        self.assertEqual((code, out.splitlines()[0]), (1, f"status: {SENSITIVE}"))
        self.assertIn("ignored ack #2: unknown rule id (made_up_rule@body:1)", out)
        self.assertIn("ignored ack #3: no such cue on this draft (payment_term@body:2)", out)
        self.assertIn("ignored ack #4: no such cue on this draft (account_term@body:1)", out)
        self.assertIn("ignored ack #5: no such cue on this draft (payment_term@subject:1)", out)
        self.assertIn("body:1 payment_term\n", out)

    def test_malformed_acks_are_reported_without_echo(self):
        bad = [SENTINEL, self.hash, f"{self.hash}:payment_term",
               self.ack("payment_term@body:1").upper(), " " + self.ack("payment_term@body:1"),
               f"{self.hash}:payment_term@footer:1", f"{self.hash}:payment_term@body:0",
               f"{self.hash[:-1]}:payment_term@body:1"]
        code, out, _ = self.run_acks(*bad, self.ack("individual_detail@body:1"))
        self.assertEqual((code, out.splitlines()[0]), (1, f"status: {SENSITIVE}"))
        for index in range(1, len(bad) + 1):
            self.assertIn(f"ignored ack #{index}: malformed acknowledgement\n", out)
        self.assertNotIn(SENTINEL, out)
        self.assertNotIn(self.hash[:16], out)
        self.assertIn("body:1 individual_detail acknowledged", out)

    def test_blocking_placeholder_cannot_be_acknowledged(self):
        subject, body = "TBD schedule", "See you at the tables."
        digest = ccb.draft_sha256(subject, body)
        code, out, _ = self.cli_draft(subject, body, "--ack",
                                      f"{digest}:caps_placeholder@subject:1")
        self.assertEqual((code, out.splitlines()[0]), (1, f"status: {PLACEHOLDER}"))
        self.assertIn("ignored ack #1: blocking placeholders cannot be acknowledged "
                      "(caps_placeholder@subject:1)", out)

    def test_acknowledged_cues_do_not_clear_a_placeholder(self):
        subject, body = "Game update", "Doors at TBD. Visit https://club.example"
        digest = ccb.draft_sha256(subject, body)
        code, out, _ = self.cli_draft(subject, body, "--ack", f"{digest}:link@body:1")
        self.assertEqual(code, 1)
        self.assertEqual(out.splitlines(), [f"status: {PLACEHOLDER}", "body:1 caps_placeholder",
                                            "body:1 link acknowledged"])

    def test_acknowledgement_writes_nothing(self):
        modes = []
        real_open = open

        def spy(file, mode="r", *args, **kwargs):
            modes.append(mode)
            return real_open(file, mode, *args, **kwargs)

        before = sorted(os.listdir(self.tmp))
        with mock.patch("builtins.open", spy):
            code, _, _ = self.run_acks(*(self.ack(c) for c in self.CUES))
        self.assertEqual(code, 0)
        self.assertTrue(modes)
        self.assertTrue(all(set(mode) <= set("rbt") for mode in modes), modes)
        self.assertEqual(sorted(os.listdir(self.tmp)), before)


# -------------------------------------------------------------------- input

class InputTests(TempDirTestCase):
    ADDRESS = "seat.holder@club.example"

    def test_recipient_keys_are_rejected_before_any_address_is_printed(self):
        for key in ("to", "To", "recipients", "cc", "bcc"):
            for extra in ((), ("--json",), ("--preview",)):
                with self.subTest(key=key, mode=extra):
                    path = self.write_draft({"subject": "Game update",
                                             "body": "Doors open at seven.", key: self.ADDRESS})
                    code, out, err = run_cli("--draft", path, *extra)
                    self.assertEqual(code, 2)
                    self.assertIn(INPUT_ERROR, out)
                    self.assertIn("recipient", out)
                    for text in (self.ADDRESS, "@", "seat.holder", "Doors open"):
                        self.assertNotIn(text, out + err)

    def test_wrong_json_shapes_are_input_errors(self):
        payloads = [
            b'{"subject": "Game update"}',
            b'{"subject": "Game update", "body": "Doors open.", "note": "Zephyrquill"}',
            b'{"subject": "Game update", "body": 7}',
            b'{"subject": ["Zephyrquill"], "body": "Doors open."}',
            b'["Game update", "Zephyrquill"]',
            b'"Zephyrquill"',
            b'{"subject": "Game update", "body": "Doors open.", "body": "Zephyrquill"}',
            b'{"subject": "Game update", "body": "Zephyrquill',
            b"",
            b'{"subject": "Game update", "body": "Zephyrquill \\ud800 seats"}',
            b'{"subject": "Game update", "body": "Zephyrquill \\u0000 seats"}',
        ]
        for index, raw in enumerate(payloads):
            with self.subTest(index):
                path = self.write_bytes(f"d{index}.json", raw)
                self.assert_input_error(run_cli("--draft", path), SENTINEL)

    def test_utf16_and_invalid_utf8_are_rejected_without_echo(self):
        text = json.dumps({"subject": "Game update", "body": f"{SENTINEL} seats"})
        variants = {
            "utf16_bom": text.encode("utf-16"),
            "utf16_be_bom": b"\xfe\xff" + text.encode("utf-16-be"),
            "utf16_le_no_bom": text.encode("utf-16-le"),
            "invalid_utf8": b'{"subject": "Game update", "body": "Zephyrquill \xff\xfe seats"}',
        }
        for name, raw in variants.items():
            with self.subTest(name):
                path = self.write_bytes(f"{name}.json", raw)
                self.assert_input_error(run_cli("--draft", path), SENTINEL, "xff", "0xff")
                body = self.write_bytes(f"{name}.txt", raw)
                self.assert_input_error(run_cli("--subject", "Game update", "--body-file", body),
                                        SENTINEL, "xff", "0xff")

    def test_utf8_bom_is_tolerated(self):
        payload = json.dumps({"subject": "Game update", "body": "Doors open at seven."})
        path = self.write_bytes("bom.json", b"\xef\xbb\xbf" + payload.encode("utf-8"))
        self.assertEqual(run_cli("--draft", path)[0], 0)
        body = self.write_bytes("bom.txt", b"\xef\xbb\xbfDoors open at seven.")
        self.assertEqual(run_cli("--subject", "Game update", "--body-file", body)[0], 0)

    def test_blank_after_trim(self):
        for subject, body in (("   ", "Doors open."), ("", "Doors open."),
                              ("Game update", "\ufeff \r\n\t "), ("\ufeff", "Doors open.")):
            with self.subTest(subject=subject, body=body):
                self.assert_input_error(self.cli_draft(subject, body))
        blank = self.write_bytes("blank.txt", b" \r\n\t\r\n")
        self.assert_input_error(run_cli("--subject", "Game update", "--body-file", blank))

    def test_length_limits_count_code_points_after_trim(self):
        for subject, body in (("\u00e9" * 200, "Doors open."), ("  " + "a" * 200 + "  ", "Doors open."),
                              ("Game update", "b" * 10_000), ("Game update", "\u00e9" * 10_000)):
            with self.subTest(len_subject=len(subject), len_body=len(body)):
                self.assertEqual(self.cli_draft(subject, body)[0], 0)
        out = self.assert_input_error(self.cli_draft("a" * 201, "Doors open."))
        self.assertIn("over 200", out)
        out = self.assert_input_error(self.cli_draft("Game update", "b" * 10_001))
        self.assertIn("over 10000", out)

    def test_trim_is_the_shared_js_compatible_trim(self):
        self.assertIs(ccb.csc, csc)
        with open(ccb.__file__, encoding="utf-8") as handle:
            source = handle.read()
        self.assertIn("csc._trim(", source)
        self.assertNotIn("def _trim", source)
        result = ccb.check_draft("\ufeff\t Game update \u00a0", "\n\n Doors open at seven. \ufeff")
        self.assertEqual((result.subject, result.body), ("Game update", "Doors open at seven."))
        self.assertEqual(result.draft_sha256, hashlib.sha256(
            "Game update\0Doors open at seven.".encode("utf-8")).hexdigest())

    def test_body_file_mode_matches_json_mode(self):
        body = "A member owes $120 in dues."
        path = self.write_bytes("body.txt", ("\r\n" + body + "\r\n").encode("utf-8"))
        file_mode = run_cli("--subject", "Game update", "--body-file", path, "--preview")
        json_mode = self.cli_draft("Game update", body, "--preview")
        self.assertEqual(file_mode, json_mode)
        self.assertEqual(file_mode[0], 1)

    def test_argument_errors_are_input_errors(self):
        draft = self.write_draft({"subject": "Game update", "body": "Doors open."})
        body = self.write_bytes("b.txt", b"Doors open.")
        for argv in [
            (),
            ("--subject", "Game update"),
            ("--body-file", body),
            ("--draft", draft, "--subject", "Game update", "--body-file", body),
            ("--draft", draft, "--preview", "--json"),
            ("--draft", os.path.join(self.tmp, "missing.json")),
            ("--draft", draft, f"--{SENTINEL}"),
            ("--draft", draft, SENTINEL),
            ("--draft",),
            ("--expectations", EXPECTATIONS, "--draft", draft),
            ("--expectations", EXPECTATIONS, "--json"),
        ]:
            with self.subTest(argv=argv):
                self.assert_input_error(run_cli(*argv), SENTINEL)


# --------------------------------------------------------------- amendment 1

NBSP = "\N{NO-BREAK SPACE}"

# Review drafts A01 to A06, A20, A25, A26, A35, A36 and A41 from
# REVIEW_BUILD_18_2026-10-03.md, inputs verbatim. The review gives no body for
# A41 (a subject-only row), so a clean body is used.
REVIEW_DRAFTS = [
    ("A01", "Game update", "Hello {{\nfirst_name\n}}, seats are ready.", PLACEHOLDER,
     {("body", 1, "brace_token")}, 1),
    ("A02", "Game update", "Hello {{first_name\n}}, seats are ready.", PLACEHOLDER,
     {("body", 1, "brace_token")}, 1),
    ("A03", "Game update", "Dear <\nFIRST_NAME>, doors at seven.", PLACEHOLDER,
     {("body", 1, "angle_token")}, 1),
    ("A04", "Game update", "Please RSVP by [add\ndate].", PLACEHOLDER,
     {("body", 1, "square_editorial")}, 1),
    ("A05", "Game update", "Please RSVP by [add date [optional]].", PLACEHOLDER,
     {("body", 1, "square_editorial")}, 1),
    ("A06", "Game update", "Doors at [seats\ntbd].", PLACEHOLDER,
     {("body", 2, "caps_placeholder")}, 1),
    ("A20", "Game update", "Dear [Name], doors at [time].", SENSITIVE,
     {("body", 1, "bracket_span")}, 1),
    ("A25", "Game update", "Call 555 - 201 - 7788 tonight.", SENSITIVE,
     {("body", 1, "phone_shape")}, 1),
    ("A26", "Game update", f"Call 555{NBSP}201{NBSP}7788 tonight.", SENSITIVE,
     {("body", 1, "phone_shape")}, 1),
    ("A35", "Game update", "Private: Quill is out\rDoors open at seven tonight.", CLEAR, set(), 0),
    ("A36", "Game update", "Doors open at seven.\x1b[8m Quill is out of the club\x1b[0m", CLEAR,
     set(), 0),
    ("A41", "Seats T\nBD", "Doors open at seven.", INPUT_ERROR, set(), 2),
]
REVIEW_BY_ID = {case[0]: case for case in REVIEW_DRAFTS}

# Preview marks (item 3): character -> mark.
PREVIEW_MARKS = {
    "\x07": "<U+0007>", "\x0b": "<U+000B>", "\x0c": "<U+000C>", "\x1b": "<U+001B>",
    "\x7f": "<U+007F>", "\x85": "<U+0085>", "\x9b": "<U+009B>",
    "\N{SOFT HYPHEN}": "<U+00AD>",
    "\N{ZERO WIDTH SPACE}": "<U+200B>", "\N{ZERO WIDTH NON-JOINER}": "<U+200C>",
    "\N{ZERO WIDTH JOINER}": "<U+200D>", "\N{WORD JOINER}": "<U+2060>",
    "\N{ZERO WIDTH NO-BREAK SPACE}": "<U+FEFF>",
    "\N{LEFT-TO-RIGHT EMBEDDING}": "<U+202A>", "\N{RIGHT-TO-LEFT EMBEDDING}": "<U+202B>",
    "\N{POP DIRECTIONAL FORMATTING}": "<U+202C>", "\N{LEFT-TO-RIGHT OVERRIDE}": "<U+202D>",
    "\N{RIGHT-TO-LEFT OVERRIDE}": "<U+202E>", "\N{LEFT-TO-RIGHT ISOLATE}": "<U+2066>",
    "\N{RIGHT-TO-LEFT ISOLATE}": "<U+2067>", "\N{FIRST STRONG ISOLATE}": "<U+2068>",
    "\N{POP DIRECTIONAL ISOLATE}": "<U+2069>",
}


class AmendmentOneTests(TempDirTestCase):
    def test_review_drafts(self):
        for case_id, subject, body, status, cues, exit_code in REVIEW_DRAFTS:
            with self.subTest(case_id):
                result = ccb.check_draft(subject, body)
                self.assertEqual(result.status, status)
                self.assertEqual({(c.field, c.line, c.rule) for c in result.cues}, cues)
                self.assertEqual(result.exit_code, exit_code)

    def test_review_drafts_through_the_cli(self):
        for case_id, subject, body, status, cues, exit_code in REVIEW_DRAFTS:
            with self.subTest(case_id):
                code, out, err = self.cli_draft(subject, body)
                lines = out.splitlines()
                self.assertEqual(code, exit_code)
                self.assertEqual(lines[0], f"status: {status}")
                if status != INPUT_ERROR:
                    self.assertEqual(set(lines[1:]), {f"{f}:{n} {r}" for f, n, r in cues})
                for text in ("Quill", "first_name", "seats", "555", "Name"):
                    self.assertNotIn(text, out + err)

    # Item 1: tokens and bracket spans cross line breaks; insert_here does not.
    def test_cross_line_matches_take_the_line_where_they_start(self):
        body = "Intro line.\nHello {{\nfirst_name\n}} and <\nvenue> and [add\ndate]."
        result = ccb.check_draft("Game update", body)
        self.assertEqual({(c.line, c.rule) for c in result.cues},
                         {(2, "brace_token"), (4, "angle_token"), (5, "square_editorial")})
        offsets = {c.rule: c.offsets for c in result.cues}
        start, end = offsets["brace_token"][0]
        self.assertEqual(body[start:end], "{{\nfirst_name\n}}")
        start, end = offsets["square_editorial"][0]
        self.assertEqual(body[start:end], "[add\ndate]")

    def test_bracket_exclusion_for_word_placeholder_crosses_lines(self):
        self.assertEqual(found("See [note\nplaceholder] soon."),
                         {("body", 2, "caps_placeholder")})
        self.assertEqual(found("See the\nplaceholder soon."), {("body", 2, "word_placeholder")})

    def test_nested_bracket_spans(self):
        # The inner [x] matches no blocking rule, so it is also a bracket_span.
        self.assertEqual(body_rules("Doors at [seats [x] tbd]."),
                         {"caps_placeholder", "bracket_span"})
        self.assertEqual(body_rules("Doors at [optional [add date]]."), {"square_editorial"})
        self.assertEqual(body_rules("Doors at [tbd"), set())
        self.assertEqual(body_rules("Doors at tbd]"), set())

    # Item 2: phone separators.
    def test_phone_separator_runs(self):
        separators = [" - ", NBSP, "\N{NARROW NO-BREAK SPACE}", "\N{IDEOGRAPHIC SPACE}", "\t",
                      "\N{HYPHEN}", "\N{NON-BREAKING HYPHEN}", "\N{FIGURE DASH}",
                      "\N{EN DASH}", "\N{EM DASH}", "\N{HORIZONTAL BAR}", "\N{MINUS SIGN}",
                      ") (", " . ", "\n", "\r\n"]
        for sep in separators:
            with self.subTest(sep=ascii(sep)):
                body = f"Call 555{sep}201{sep}7788 tonight."
                self.assertEqual(found(body), {("body", 1, "phone_shape")})
        self.assertEqual(body_rules(f"+1{NBSP}(555){NBSP}201{NBSP}7788"), {"phone_shape"})
        for body in ("Call 555 -- 201 - 7788", "Call 555_201_7788", "Call 555/201/7788"):
            with self.subTest(body=body):
                self.assertNotIn("phone_shape", body_rules(body))

    # Item 3: preview marks.
    def test_preview_marks_control_and_invisible_characters(self):
        for char, mark in PREVIEW_MARKS.items():
            with self.subTest(mark):
                body = f"Doors open{char}at seven."
                code, out, err = self.cli_draft("Game update", body, "--preview")
                self.assertEqual(code, 0)
                self.assertIn(f"Doors open{mark}at seven.", out)
                self.assertNotIn(char, out + err)
                self.assertIn("<U+XXXX> marks a control or invisible character", out)
                self.assertIn("draft_sha256: " + hashlib.sha256(
                    ("Game update\0" + body).encode("utf-8")).hexdigest(), out)
        code, out, _ = self.cli_draft("Game\N{ZERO WIDTH SPACE}update", "Doors open.", "--preview")
        self.assertIn("Subject: Game<U+200B>update\n", out)

    def test_preview_keeps_tab_lf_and_crlf(self):
        body = "Doors\topen\nat seven\r\nsharp."
        _, out, _ = self.cli_draft("Game update", body, "--preview")
        self.assertIn(body, out)
        self.assertNotIn("<U+", out)

    def test_a35_and_a36_preview_cannot_hide_text(self):
        for case_id, shown in (
                ("A35", "Private: Quill is out<U+000D>Doors open at seven tonight.\n"),
                ("A36", "Doors open at seven.<U+001B>[8m Quill is out of the club<U+001B>[0m\n")):
            with self.subTest(case_id):
                _, subject, body, *_ = REVIEW_BY_ID[case_id]
                code, out, _ = self.cli_draft(subject, body, "--preview")
                self.assertEqual(code, 0)
                self.assertIn(shown, out)
                self.assertNotIn("\r", out)
                self.assertNotIn("\x1b", out)
                real = hashlib.sha256(("Game update\0" + body).encode("utf-8")).hexdigest()
                marked = hashlib.sha256(
                    ("Game update\0" + ccb.visible(body)).encode("utf-8")).hexdigest()
                self.assertIn(f"draft_sha256: {real}", out)
                self.assertNotIn(marked, out)

    # Item 4: a subject line break is an input error.
    def test_subject_line_break_is_input_error(self):
        for subject in ("Seats T\nBD", "Seats\r\nTBD", "Seats\rTBD", "Game\nupdate"):
            with self.subTest(subject=ascii(subject)):
                self.assert_input_error(self.cli_draft(subject, "Doors open at seven."),
                                        "Seats", "TBD", "BD")
        body = self.write_bytes("b.txt", b"Doors open at seven.")
        self.assert_input_error(run_cli("--subject", "Seats T\nBD", "--body-file", body))
        # Breaks at either end are trimmed first, as the page's field would drop them.
        self.assertEqual(self.cli_draft("\nGame update\r\n", "Doors open at seven.")[0], 0)

    # Item 5: bracket_span.
    def test_bracket_span_is_a_clearable_cue(self):
        _, subject, body, *_ = REVIEW_BY_ID["A20"]
        digest = ccb.draft_sha256(subject, body)
        _, out, _ = self.cli_draft(subject, body, "--preview")
        self.assertIn(f"body:1 bracket_span  ack id: {digest}:bracket_span@body:1", out)
        code, out, _ = self.cli_draft(subject, body, "--ack", f"{digest}:bracket_span@body:1")
        self.assertEqual(code, 0)
        self.assertEqual(out.splitlines(), [f"status: {CLEAR}", "body:1 bracket_span acknowledged"])
        _, out, _ = self.cli_draft(subject, body, "--json")
        (cue,) = json.loads(out)["cues"]
        self.assertEqual((cue["kind"], cue["offsets"]), ("sensitive", [[5, 11], [22, 28]]))

    def test_bracket_span_only_when_no_blocking_rule_matched(self):
        self.assertEqual(body_rules("Please RSVP by [add date]."), {"square_editorial"})
        self.assertEqual(body_rules("Doors at [seats tbd]."), {"caps_placeholder"})
        self.assertEqual(body_rules("Seats [{{venue}}] ready."), {"brace_token"})
        self.assertEqual(body_rules("Insert [photo] here."), {"insert_here"})
        self.assertEqual(body_rules("[Name] seats TBD."), {"bracket_span", "caps_placeholder"})
        self.assertEqual(body_rules("Doors at {time}."), {"brace_token"})
        self.assertEqual(body_rules("Doors at [time"), set())
        self.assertEqual(found("Doors at [time\nand place]."), {("body", 1, "bracket_span")})

    # Item 6: rule 4 priority on a draft with both kinds of cue.
    def test_placeholder_outranks_unacknowledged_sensitive_cues(self):
        subject, body = "Game update", "Seats TBD. A member owes dues. Visit https://club.example"
        result = ccb.check_draft(subject, body)
        self.assertEqual(result.status, PLACEHOLDER)
        self.assertEqual({c.rule for c in result.cues},
                         {"caps_placeholder", "individual_detail", "payment_term", "link"})
        self.assertTrue(any(c.kind == "sensitive" and not c.acknowledged for c in result.cues))
        code, out, _ = self.cli_draft(subject, body)
        self.assertEqual((code, out.splitlines()[0]), (1, f"status: {PLACEHOLDER}"))
        digest = ccb.draft_sha256(subject, body)
        acks = []
        for cue_id in ("individual_detail@body:1", "payment_term@body:1", "link@body:1"):
            acks += ["--ack", f"{digest}:{cue_id}"]
        code, out, _ = self.cli_draft(subject, body, *acks)
        self.assertEqual((code, out.splitlines()[0]), (1, f"status: {PLACEHOLDER}"))


# --------------------------------------------------------------- amendment 2

ZWSP = chr(0x200B)
TAG_TEXT = "Quill owes 500"
TAGS = "".join(chr(0xE0000 + ord(char)) for char in TAG_TEXT)

# Re-review drafts N27, N33 and N25 (scratchpad review18/r1_new.py) and the
# first review's A23 and A24, inputs verbatim. N27_MIXED is the re-review's
# confirming draft: a real U+200B first, then the same mark typed literally.
AMENDMENT_2_DRAFTS = [
    ("N27", "Game update", "Doors open<U+200B>at seven.", PLACEHOLDER,
     {("body", 1, "preview_mark")}, 1),
    ("N27_MIXED", "Game update", f"Doors open{ZWSP}at <U+200B>seven.", PLACEHOLDER,
     {("body", 1, "preview_mark")}, 1),
    ("N33", "Game update", "Hi {{user.first_name}}!", SENSITIVE,
     {("body", 1, "bracket_span")}, 1),
    ("A23", "Game update", "Hi {{user.first_name}}!", SENSITIVE,
     {("body", 1, "bracket_span")}, 1),
    ("A24", "Game update", "Hi *|FNAME|*!", PLACEHOLDER, {("body", 1, "merge_tag")}, 1),
    ("N25_TAGS", "Game update", "Doors open at seven." + TAGS, CLEAR, set(), 0),
]
AMENDMENT_2_BY_ID = {case[0]: case for case in AMENDMENT_2_DRAFTS}

# Item 4: format characters (Cf), U+2028, U+2029 and the whole tag block.
NEWLY_MARKED = (0x200E, 0x200F, 0x2061, 0x2062, 0x2063, 0x2064, 0x206A, 0x206F,
                0x061C, 0x180E, 0xFFF9, 0xFFFB, 0x2028, 0x2029,
                0xE0000, 0xE0001, 0xE001F, 0xE0020, 0xE0051, 0xE007F)


class AmendmentTwoTests(TempDirTestCase):
    def test_amendment_2_drafts(self):
        for case_id, subject, body, status, cues, exit_code in AMENDMENT_2_DRAFTS:
            with self.subTest(case_id):
                result = ccb.check_draft(subject, body)
                self.assertEqual(result.status, status)
                self.assertEqual({(c.field, c.line, c.rule) for c in result.cues}, cues)
                self.assertEqual(result.exit_code, exit_code)
                code, out, err = self.cli_draft(subject, body)
                self.assertEqual((code, out.splitlines()[0]), (exit_code, f"status: {status}"))
                for text in ("Quill", "<U+", "FNAME", "user.first", "Doors"):
                    self.assertNotIn(text, out + err)

    # Item 1: preview_mark.
    def test_preview_mark_blocks_and_cannot_be_acknowledged(self):
        for case_id in ("N27", "N27_MIXED"):
            with self.subTest(case_id):
                _, subject, body, *_ = AMENDMENT_2_BY_ID[case_id]
                digest = ccb.draft_sha256(subject, body)
                _, out, _ = self.cli_draft(subject, body, "--preview")
                self.assertIn("body:1 preview_mark  blocking; edit the draft "
                              "(cannot be acknowledged)", out)
                code, out, _ = self.cli_draft(subject, body, "--ack",
                                              f"{digest}:preview_mark@body:1")
                self.assertEqual((code, out.splitlines()[0]), (1, f"status: {PLACEHOLDER}"))
                self.assertIn("ignored ack #1: blocking placeholders cannot be acknowledged "
                              "(preview_mark@body:1)", out)

    def test_mixed_real_and_literal_marks_look_alike_but_block(self):
        _, subject, body, *_ = AMENDMENT_2_BY_ID["N27_MIXED"]
        _, out, _ = self.cli_draft(subject, body, "--preview")
        self.assertIn("Doors open<U+200B>at <U+200B>seven.\n", out)
        self.assertNotIn(ZWSP, out)
        self.assertIn(f"status: {PLACEHOLDER}", out)

    def test_preview_text_pasted_back_is_blocked(self):
        body = f"Doors open{ZWSP}at seven."
        _, out, _ = self.cli_draft("Game update", body, "--preview")
        pasted = next(line for line in out.splitlines() if line.startswith("Doors open"))
        self.assertEqual(pasted, "Doors open<U+200B>at seven.")
        self.assertEqual(found(pasted), {("body", 1, "preview_mark")})
        tag_preview = ccb.visible("Doors open at seven." + TAGS)
        self.assertEqual(found(tag_preview), {("body", 1, "preview_mark")})

    def test_preview_mark_pattern(self):
        for text in ("<U+200B>", "<u+200b>", "<U+E0051>", "<U+10FFFF>", "x<U+00ad>y"):
            with self.subTest(hit=text):
                self.assertIn("preview_mark", body_rules(f"Doors {text} open."))
        self.assertEqual(found("Doors open.", subject="Seats <U+2028> soon"),
                         {("subject", 1, "preview_mark")})
        for text in ("<U+200>", "<U+1234567>", "<U 200B>", "U+200B", "<U-200B>", "<V+200B>"):
            with self.subTest(miss=text):
                self.assertNotIn("preview_mark", body_rules(f"Doors {text} open."))

    # Item 2: bracket_span covers {...} pairs.
    def test_bracket_span_covers_brace_pairs(self):
        self.assertEqual(body_rules("Bring {1} chips."), {"bracket_span"})
        self.assertEqual(body_rules("Bring { } chips."), {"bracket_span"})
        self.assertEqual(body_rules("Hi {user.first_name}!"), {"bracket_span"})
        self.assertEqual(found("Hi {user.\nfirst_name}!"), {("body", 1, "bracket_span")})
        self.assertEqual(body_rules("Hello {{first_name}}, seats ready."), {"brace_token"})
        self.assertEqual(body_rules("Seats {tbd} soon."), {"caps_placeholder", "brace_token"})
        _, subject, body, *_ = AMENDMENT_2_BY_ID["N33"]
        digest = ccb.draft_sha256(subject, body)
        code, out, _ = self.cli_draft(subject, body, "--ack", f"{digest}:bracket_span@body:1")
        self.assertEqual(code, 0)
        self.assertEqual(out.splitlines(), [f"status: {CLEAR}", "body:1 bracket_span acknowledged"])

    # Item 3: merge_tag.
    def test_merge_tag_blocks(self):
        for body in ("Hi *|FNAME|*!", "Hi *|IF:VIP|*!", "Hi *|A|B|*!", "Hi *||*!"):
            with self.subTest(hit=body):
                self.assertEqual(body_rules(body), {"merge_tag"})
        self.assertEqual(found("Hi *|\nFNAME\n|*!"), {("body", 1, "merge_tag")})
        for body in ("Hi *FNAME*!", "Hi |FNAME|!", "Hi * | FNAME | *!", "Hi *|FNAME"):
            with self.subTest(miss=body):
                self.assertNotIn("merge_tag", body_rules(body))
        _, subject, body, *_ = AMENDMENT_2_BY_ID["A24"]
        digest = ccb.draft_sha256(subject, body)
        code, out, _ = self.cli_draft(subject, body, "--ack", f"{digest}:merge_tag@body:1")
        self.assertEqual((code, out.splitlines()[0]), (1, f"status: {PLACEHOLDER}"))
        self.assertIn("blocking placeholders cannot be acknowledged (merge_tag@body:1)", out)

    # Item 4: preview marks every format character, U+2028, U+2029 and tag characters.
    def test_preview_marks_format_characters_and_separators(self):
        for code_point in NEWLY_MARKED:
            mark = f"<U+{code_point:04X}>"
            with self.subTest(mark):
                body = f"Doors open{chr(code_point)}at seven."
                code, out, err = self.cli_draft("Game update", body, "--preview")
                self.assertIn(f"Doors open{mark}at seven.\n", out)
                self.assertNotIn(chr(code_point), out + err)
                self.assertIn("draft_sha256: " + hashlib.sha256(
                    ("Game update\0" + body).encode("utf-8")).hexdigest(), out)
        _, out, _ = self.cli_draft("Seats T\N{LINE SEPARATOR}BD", "Doors open.", "--preview")
        self.assertIn("Subject: Seats T<U+2028>BD\n", out)
        for plain in ("caf\N{LATIN SMALL LETTER E WITH ACUTE}", "a\N{NO-BREAK SPACE}b"):
            self.assertEqual(ccb.visible(plain), plain)

    def test_tag_character_draft_is_shown_in_the_preview(self):
        _, subject, body, status, _, exit_code = AMENDMENT_2_BY_ID["N25_TAGS"]
        code, out, err = self.cli_draft(subject, body, "--preview")
        self.assertEqual((code, status), (exit_code, CLEAR))
        marks = "".join(f"<U+{0xE0000 + ord(char):05X}>" for char in TAG_TEXT)
        self.assertIn(f"Doors open at seven.{marks}\n", out)
        self.assertFalse(any(0xE0000 <= ord(char) <= 0xE007F for char in out + err))
        self.assertIn("<U+XXXX> marks a control or invisible character", out)
        self.assertIn("draft_sha256: " + hashlib.sha256(
            ("Game update\0" + body).encode("utf-8")).hexdigest(), out)


# -------------------------------------------------------------------- guard

class GuardTests(unittest.TestCase):
    def test_network_subprocess_and_firestore_are_blocked(self):
        with self.assertRaises(RuntimeError):
            socket.create_connection(("club.example", 443))
        with self.assertRaises(RuntimeError):
            socket.getaddrinfo("club.example", 443)
        with self.assertRaises(RuntimeError):
            urllib.request.urlopen("https://club.example")
        with self.assertRaises(RuntimeError):
            subprocess.run(["node", "--version"])
        sock = socket.socket()
        try:
            with self.assertRaises(RuntimeError):
                sock.connect(("127.0.0.1", 9))
        finally:
            sock.close()
        import firebase_admin
        with self.assertRaises(RuntimeError):
            firebase_admin.initialize_app()

    def test_checker_imports_no_network_firestore_or_process_module(self):
        with open(ccb.__file__, encoding="utf-8") as handle:
            source = handle.read()
        imported = set()
        for node in ast.walk(ast.parse(source)):
            if isinstance(node, ast.Import):
                imported |= {alias.name.split(".")[0] for alias in node.names}
            elif isinstance(node, ast.ImportFrom):
                imported.add((node.module or "").split(".")[0])
        allowed = {"__future__", "argparse", "bisect", "hashlib", "json", "os", "re", "sys",
                   "unicodedata", "dataclasses", "check_schedule_copy"}
        self.assertLessEqual(imported, allowed)
        for token in ("__import__", "importlib", "socket", "urllib", "subprocess", "firebase",
                      "startfile", "spawn", "popen", "system("):
            self.assertNotIn(token, source)
        tree = ast.parse(source)
        os_attributes = {node.attr for node in ast.walk(tree)
                         if isinstance(node, ast.Attribute)
                         and isinstance(node.value, ast.Name) and node.value.id == "os"}
        self.assertEqual(os_attributes, {"path"})
        called = {node.func.id for node in ast.walk(tree)
                  if isinstance(node, ast.Call) and isinstance(node.func, ast.Name)}
        self.assertFalse(called & {"eval", "exec", "compile", "__import__", "getattr"})

    def test_os_process_launchers_are_blocked(self):
        self.assertIn("system", OS_LAUNCHERS)
        self.assertTrue(any(name.startswith("spawn") for name in OS_LAUNCHERS))
        self.assertTrue(any(name.startswith("exec") for name in OS_LAUNCHERS))
        if sys.platform == "win32":
            self.assertIn("startfile", OS_LAUNCHERS)
        # Identity first, so a missing patch fails here before anything could run.
        for name in OS_LAUNCHERS:
            with self.subTest(name):
                self.assertIs(getattr(os, name), _refuse)
        with self.assertRaises(RuntimeError):
            os.system("exit 0")

    def test_own_files_have_no_em_or_en_dash(self):
        for name in OWN_FILES:
            with self.subTest(name):
                with open(os.path.join(HERE, name), encoding="utf-8") as handle:
                    text = handle.read()
                self.assertTrue(text.isascii(), name)
                self.assertNotIn("\u2014", text)
                self.assertNotIn("\u2013", text)


if __name__ == "__main__":
    unittest.main()

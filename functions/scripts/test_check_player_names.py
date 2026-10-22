"""Offline tests for check_player_names.py. No network, no Firestore, no Jev call.

Every name in this file is invented. None comes from Firestore or from any export.

From the repo root:
    python -m unittest functions/scripts/test_check_player_names.py -v
"""

import contextlib
import copy
import importlib.util
import io
import json
import os
import re
import sys
import tempfile
import types
import unicodedata
import unittest
import urllib.request
from pathlib import Path
from unittest import mock

HERE = Path(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, str(HERE))

import check_player_names as cpn  # noqa: E402

EXPECTATIONS = HERE / "player_names_expectations.json"
SCRIPT = HERE / "check_player_names.py"
THIS_FILE = HERE / "test_check_player_names.py"

# Dashes are built from code points so this file carries none itself.
EM_DASH = chr(0x2014)
EN_DASH = chr(0x2013)

# Non-ASCII text is written as escapes so the stored form is unambiguous.
JOSE_COMPOSED = "José Ibáñez"
JOSE_DECOMPOSED = "José Ibáñez"

# The names the pre-checks must stay silent on.
SILENT_NINE = [
    "Anne-Marie Castellano", JOSE_COMPOSED, "J.R.", "Jr.", "St. John",
    "Tasha W.", "O'Brien", "Big Mike", "Testing 123",
]

LONG_NAME = "Abcdefghij " * 3 + "Abcdefgh"  # 41 characters
assert len(LONG_NAME) == 41

PLAUSIBLE = "plausible_person_name"
GOOD = {"name_kind": PLAUSIBLE, "offensive_content": 0.05}


def rec(rid="r1", name="Big Mike", source="checkin", **extra):
    out = {"id": rid, "name": name, "source": source}
    out.update(extra)
    return out


def canned(answers_by_id):
    return cpn.OfflineAnswers(answers_by_id)


def jev_choice(choice, plausible=None, **extra):
    """A full Jev choice answer; `plausible` is the debiased plausible_person_name probability."""
    answer = {"type": "choice", "choice": choice}
    if plausible is not None:
        answer["probabilities"] = {PLAUSIBLE: plausible}
    answer.update(extra)
    return answer


def recording_asker(answers=None):
    """An asker that records every call and returns the same canned answers (or none)."""
    calls = []

    def asker(record, state, questions):
        calls.append((record["id"], copy.deepcopy(state), questions))
        return {} if answers is None else answers

    asker.calls = calls
    return asker


def expectations_meta():
    return json.loads(EXPECTATIONS.read_text(encoding="utf-8"))


def canned_from_expectations():
    """Canned answers equal to the frozen expectations (checks the harness, not the model)."""
    answers = {}
    for case in expectations_meta()["cases"]:
        expected = case["expected"]
        if not expected["jev_asked"]:
            continue
        level = {"high": 0.9, "low": 0.05}.get(expected.get("offensive_content"), 0.1)
        answers[case["id"]] = {"name_kind": expected["name_kind"], "offensive_content": level}
    return answers


class NormaliseTests(unittest.TestCase):
    def test_trim_and_collapse_whitespace(self):
        self.assertEqual(cpn.normalise("  Big   Mike "), "Big Mike")
        self.assertEqual(cpn.normalise("Big \t\n Mike"), "Big Mike")
        self.assertEqual(cpn.normalise(""), "")
        self.assertEqual(cpn.normalise("   "), "")

    def test_nfc_composes_a_decomposed_name(self):
        self.assertNotEqual(JOSE_DECOMPOSED, JOSE_COMPOSED)
        self.assertEqual(cpn.normalise(JOSE_DECOMPOSED), JOSE_COMPOSED)
        self.assertTrue(unicodedata.is_normalized("NFC", cpn.normalise(JOSE_DECOMPOSED)))

    def test_system_fillers_match_only_the_placeholder_pattern(self):
        for text in ("Unrecorded Player", "unrecorded player 12", "UNRECORDED PLAYER 3"):
            with self.subTest(text=text):
                self.assertTrue(cpn.is_filler(cpn.normalise(text)))
        self.assertTrue(cpn.is_filler(cpn.normalise("  Unrecorded   Player  3 ")))
        for text in ("Unrecorded Player Dave", "Unrecorded Players", "Unrecorded Player 3 4", "Big Mike"):
            with self.subTest(text=text):
                self.assertFalse(cpn.is_filler(cpn.normalise(text)))


class PreCheckTests(unittest.TestCase):
    def flags(self, text):
        return cpn.precheck_flags(cpn.normalise(text))

    def kind(self, text):
        text = cpn.normalise(text)
        return cpn.precheck_kind(text, cpn.precheck_flags(text))

    def test_urls_are_caught_in_code(self):
        self.assertEqual(self.flags("cheapchips.biz"), ["url"])
        self.assertEqual(self.flags("www.example.org"), ["url"])
        self.assertEqual(self.flags("http://x.example/a"), ["url"])
        self.assertEqual(self.flags("Cheap.BIZ"), ["url"])
        self.assertIn("url", self.flags("see https://x.example"))
        for text in ("cheapchips.biz", "www.example.org", "http://x.example/a"):
            self.assertEqual(self.kind(text), cpn.SPAM)

    def test_a_tld_must_end_at_a_word_boundary(self):
        self.assertEqual(self.flags("Maxwell.company"), [])
        self.assertIn("url", self.flags("Maxwell.co"))

    def test_an_email_address_is_caught(self):
        flags = self.flags("someone@example.com")
        self.assertIn("email", flags)
        self.assertEqual(self.kind("someone@example.com"), cpn.SPAM)
        self.assertIn("email", self.flags("call me at a@b.c ok"))

    def test_digits_only_splits_on_seven_digits(self):
        self.assertEqual(self.flags("8675309"), ["digits_only", "too_short"])
        self.assertEqual(self.kind("8675309"), cpn.SPAM)
        self.assertIn("digits_only", self.flags("555 0100"))
        self.assertEqual(self.kind("555 0100"), cpn.SPAM)
        self.assertEqual(self.kind("+1 (555) 010-0100"), cpn.SPAM)
        self.assertIn("digits_only", self.flags("42"))
        self.assertEqual(self.kind("42"), cpn.TEST)
        self.assertEqual(self.kind("123456"), cpn.TEST)
        self.assertEqual(self.kind("1234567"), cpn.SPAM)
        self.assertEqual(self.kind("#12"), cpn.TEST)

    def test_digits_with_other_punctuation_or_letters_are_not_digits_only(self):
        self.assertNotIn("digits_only", self.flags("42!"))
        self.assertNotIn("digits_only", self.flags("Testing 123"))
        self.assertNotIn("digits_only", self.flags("A1"))

    def test_no_letters_covers_empty_punctuation_and_emoji_but_not_digits_only(self):
        for text in ("???", "", "   ", "\U0001F600", "...!!!"):
            with self.subTest(text=text):
                self.assertIn("no_letters", self.flags(text))
                self.assertEqual(self.kind(text), cpn.TEST)
        self.assertNotIn("no_letters", self.flags("42"))

    def test_exact_flag_lists_for_the_degenerate_inputs(self):
        self.assertEqual(self.flags("???"), ["no_letters", "too_short"])
        self.assertEqual(self.flags(""), ["no_letters", "too_short"])
        self.assertEqual(self.flags("42"), ["digits_only", "too_short"])

    def test_too_short_still_goes_to_the_model(self):
        self.assertEqual(self.flags("J"), ["too_short"])
        self.assertIsNone(self.kind("J"))
        self.assertEqual(self.flags("J 7"), ["too_short"])
        self.assertEqual(self.flags("Xy"), [])

    def test_too_long_is_more_than_forty_characters_after_normalising(self):
        self.assertEqual(self.flags(LONG_NAME), ["too_long"])
        self.assertIsNone(self.kind(LONG_NAME))
        self.assertEqual(self.flags(LONG_NAME[:-1]), [])
        padded = "  " + LONG_NAME[:-1].replace(" ", "    ") + "  "
        self.assertEqual(self.flags(padded), [])  # collapsing whitespace brings it to exactly 40

    def test_pre_checks_stay_silent_on_the_nine_names(self):
        for name in SILENT_NINE:
            with self.subTest(name=name):
                self.assertEqual(self.flags(name), [])
                self.assertIsNone(self.kind(name))

    def test_pre_checks_stay_silent_on_other_ordinary_shapes(self):
        for name in ("Xy", "αβγ", "Mr. Big", "Dr. Io", "A. B. Cee", "Lucky Lou", "Big Mike 2"):
            with self.subTest(name=name):
                self.assertEqual(self.flags(name), [])

    def test_decomposed_input_is_checked_in_its_composed_form(self):
        self.assertEqual(self.flags(JOSE_DECOMPOSED), [])

    def test_every_flag_name_is_one_of_the_six(self):
        seen = set()
        for text in ("a@b.c", "xy.biz", "8675309", "???", "J", LONG_NAME):
            seen.update(self.flags(text))
        self.assertEqual(seen, {"email", "url", "digits_only", "no_letters", "too_short", "too_long"})


class QuestionTests(unittest.TestCase):
    def test_label_is_the_one_in_the_brief(self):
        self.assertEqual(cpn.LABEL, "poker_player_names")

    def test_wording_matches_the_brief_exactly(self):
        qs = cpn.build_questions()
        self.assertEqual(list(qs), ["name_kind", "offensive_content"])
        self.assertEqual(
            qs["name_kind"],
            {
                "type": "choice",
                "instructions": "What kind of entry is the text in the name field",
                "criteria": {
                    "plausible_person_name": "a name a real person could go by at a bar poker night: a full name, "
                    "a first name alone, a first name with a last initial, initials, a hyphenated or accented name, "
                    "or a friendly nickname such as Lucky Lou",
                    "joke_or_offensive": "a joke, prank or pun name, an insult, or text containing profanity, "
                    "a slur or sexual content",
                    "spam_or_url_or_email": "an advertisement or promotion, a web address, an email address, "
                    "a phone number, or a plug for a social media account",
                    "test_entry": "a test or placeholder entry, such as test, asdf, xxx, player 1, guest, "
                    "or random keyboard mashing",
                    "other": "something else, such as a team or business name, or a message typed into the name box",
                },
            },
        )
        self.assertEqual(
            list(qs["name_kind"]["criteria"]),
            ["plausible_person_name", "joke_or_offensive", "spam_or_url_or_email", "test_entry", "other"],
        )
        self.assertEqual(
            qs["offensive_content"],
            {
                "type": "noul",
                "instructions": "The text contains profanity, a slur, sexual content or an insult, "
                "in any spelling or language",
            },
        )

    def test_the_plausible_option_does_not_name_a_frozen_expectation(self):
        # The example nickname is deliberately not one of the frozen names.
        text = cpn.Q_KIND_CRITERIA[PLAUSIBLE]
        for case in expectations_meta()["cases"]:
            self.assertNotIn(case["record"]["name"], text)

    def test_context_is_the_exact_fixed_text(self):
        self.assertEqual(
            cpn.CONTEXT,
            "Text a person typed into the player name box when signing in, RSVPing or joining the email list "
            "for a bar's weekly poker league. The name is shown on a public leaderboard and on a TV in the bar.",
        )


class AskPolicyTests(unittest.TestCase):
    def test_no_ask_for_email_url_digits_only_no_letters_or_a_system_filler(self):
        asker = recording_asker(GOOD)
        records = [
            rec("e", "someone@example.com"),
            rec("u1", "cheapchips.biz"),
            rec("u2", "www.example.org"),
            rec("u3", "http://x.example/a"),
            rec("d1", "8675309"),
            rec("d2", "555 0100"),
            rec("d3", "42"),
            rec("n1", "???"),
            rec("n2", ""),
            rec("f", "Unrecorded Player 3"),
        ]
        results, skipped = cpn.check_records(records, asker)
        self.assertEqual(asker.calls, [])
        self.assertEqual(skipped, 1)
        self.assertEqual(len(results), 9)
        self.assertTrue(all(r["flagged"] and not r["jev_asked"] for r in results))

    def test_ask_for_too_short_and_too_long(self):
        asker = recording_asker(GOOD)
        cpn.check_records([rec("s", "J"), rec("l", LONG_NAME)], asker)
        self.assertEqual([c[0] for c in asker.calls], ["s", "l"])

    def test_one_ask_per_remaining_record_in_input_order(self):
        asker = recording_asker(GOOD)
        records = [rec("a", "Big Mike"), rec("b", "cheapchips.biz"), rec("c", "J.R."), rec("d", "Unrecorded Player")]
        cpn.check_records(records, asker)
        self.assertEqual([c[0] for c in asker.calls], ["a", "c"])
        for _, _, questions in asker.calls:
            self.assertEqual(list(questions), ["name_kind", "offensive_content"])

    def test_state_has_exactly_context_and_the_normalised_name(self):
        asker = recording_asker(GOOD)
        cpn.check_records(
            [
                rec("a", "  Big   Mike ", source="rsvp", createdAt="2026-09-30T19:02:11Z"),
                rec("b", JOSE_DECOMPOSED),
            ],
            asker,
        )
        state_a, state_b = asker.calls[0][1], asker.calls[1][1]
        self.assertEqual(sorted(state_a), ["context", "name"])
        self.assertEqual(state_a["name"], "Big Mike")
        self.assertEqual(state_a["context"], cpn.CONTEXT)
        self.assertEqual(sorted(state_b), ["context", "name"])
        self.assertEqual(state_b["name"], JOSE_COMPOSED)

    def test_no_id_source_created_at_or_extra_field_reaches_the_state(self):
        asker = recording_asker(GOOD)
        raw = [{"id": "doc-777", "name": "Big Mike", "source": "gas_import", "createdAt": "2031-01-02T03:04:05Z",
                "email": "someone@example.com", "nameLower": "big mike", "visits": 12}]
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "names.json"
            path.write_text(json.dumps(raw), encoding="utf-8")
            records, extras = cpn.load_records(path)
        self.assertEqual(extras, ["email", "nameLower", "visits"])
        cpn.check_records(records, asker)
        sent = json.dumps(asker.calls[0][1])
        for leaked in ("doc-777", "gas_import", "2031-01-02", "someone@example.com", "big mike", "12"):
            self.assertNotIn(leaked, sent)

    def test_names_are_never_compared_with_each_other(self):
        asker = recording_asker(GOOD)
        results, _ = cpn.check_records([rec("a", "Big Mike"), rec("b", "big  mike"), rec("c", "Big Mike")], asker)
        self.assertEqual(len(asker.calls), 3)
        self.assertEqual([r["id"] for r in results], ["a", "b", "c"])
        for r in results:
            self.assertEqual(
                sorted(r),
                ["createdAt", "decided_by", "error", "flagged", "id", "jev_asked", "kind", "name", "offensive_content",
                 "order_flip", "plausible_score", "prechecks", "review_reasons", "source"],
            )
        self.assertNotIn("difflib", SCRIPT.read_text(encoding="utf-8"))

    def test_without_an_asker_nothing_is_asked_and_no_kind_is_set_for_plain_names(self):
        results, skipped = cpn.check_records([rec("a", "Big Mike"), rec("b", "J")], None)
        self.assertEqual(skipped, 0)
        self.assertFalse(any(r["jev_asked"] for r in results))
        self.assertEqual([(r["kind"], r["flagged"]) for r in results], [(None, False), (None, True)])


class LiveAskerTests(unittest.TestCase):
    def fake_client(self, behaviour):
        calls = []

        class FakeJevError(RuntimeError):
            pass

        class FakeJev:
            def ask(self, state, questions, *, debias=True, label=None):
                calls.append((state, questions, label))
                return behaviour(FakeJevError)

        client = types.ModuleType("jev.client")
        client.Jev = FakeJev
        client.JevError = FakeJevError
        package = types.ModuleType("jev")
        package.__path__ = []
        package.client = client
        return calls, {"jev": package, "jev.client": client}

    def test_importing_the_tool_does_not_import_the_client(self):
        self.assertNotIn("jev.client", sys.modules)

    def test_live_asker_asks_once_per_undecided_record_with_the_label(self):
        answers = {
            "name_kind": jev_choice(PLAUSIBLE, 0.97, value=PLAUSIBLE, order_flip=False),
            "offensive_content": {"type": "noul", "noul": 0.02, "value": 0.02},
        }
        calls, modules = self.fake_client(lambda err: answers)
        with mock.patch.dict(sys.modules, modules), mock.patch.object(sys, "path", list(sys.path)):
            asker = cpn.make_live_asker()
            results, _ = cpn.check_records([rec("a", "Big Mike"), rec("b", "cheapchips.biz")], asker)
        self.assertEqual(len(calls), 1)
        state, questions, label = calls[0]
        self.assertEqual(label, "poker_player_names")
        self.assertEqual(state, {"context": cpn.CONTEXT, "name": "Big Mike"})
        self.assertEqual(list(questions), ["name_kind", "offensive_content"])
        self.assertEqual(results[0]["kind"], PLAUSIBLE)
        self.assertEqual(results[0]["plausible_score"], 0.97)
        self.assertFalse(results[0]["flagged"])

    def test_a_jev_failure_becomes_no_answer_and_the_error_does_not_echo_the_name(self):
        def boom(err):
            raise err("HTTP 400: could not read Big Mike")

        calls, modules = self.fake_client(boom)
        with mock.patch.dict(sys.modules, modules), mock.patch.object(sys, "path", list(sys.path)):
            asker = cpn.make_live_asker()
            results, _ = cpn.check_records([rec("a", "Big Mike")], asker)
        r = results[0]
        self.assertTrue(r["flagged"])
        self.assertIn("no_answer", r["review_reasons"])
        self.assertIn("HTTP 400", r["error"])
        self.assertNotIn("Big Mike", r["error"])


class ReviewRuleTests(unittest.TestCase):
    def check(self, name="Big Mike", answers=None, rid="r1"):
        data = {} if answers is None else {rid: answers}
        return cpn.check_record(rec(rid, name), canned(data))

    def test_a_plausible_kind_with_low_offensive_content_is_not_flagged(self):
        r = self.check(answers={"name_kind": PLAUSIBLE, "offensive_content": 0.1})
        self.assertFalse(r["flagged"])
        self.assertEqual(r["review_reasons"], [])
        self.assertEqual((r["kind"], r["decided_by"], r["jev_asked"]), (PLAUSIBLE, "jev", True))

    def test_every_non_plausible_kind_flags(self):
        for kind in ("joke_or_offensive", "spam_or_url_or_email", "test_entry", "other", "something_new"):
            with self.subTest(kind=kind):
                r = self.check(answers={"name_kind": kind, "offensive_content": 0.1})
                self.assertTrue(r["flagged"])
                self.assertEqual(r["review_reasons"], [f"name_kind={kind}"])

    def test_a_plausible_kind_with_high_offensive_content_flags(self):
        r = self.check(answers={"name_kind": PLAUSIBLE, "offensive_content": 0.7})
        self.assertTrue(r["flagged"])
        self.assertEqual(r["review_reasons"], ["offensive_content>=0.5"])

    def test_the_offensive_threshold_is_half_and_above(self):
        self.assertTrue(self.check(answers={"name_kind": PLAUSIBLE, "offensive_content": 0.5})["flagged"])
        self.assertFalse(self.check(answers={"name_kind": PLAUSIBLE, "offensive_content": 0.49})["flagged"])

    def test_a_missing_answer_flags_no_answer_instead_of_passing(self):
        r = self.check(answers=None)
        self.assertTrue(r["flagged"])
        self.assertEqual(r["review_reasons"], ["no_answer"])
        self.assertIn("no offline answers for r1", r["error"])
        self.assertIsNone(r["kind"])
        self.assertIsNone(r["decided_by"])

    def test_a_partial_answer_also_flags_no_answer(self):
        only_kind = self.check(answers={"name_kind": PLAUSIBLE})
        self.assertEqual(only_kind["review_reasons"], ["no_answer"])
        only_offensive = self.check(answers={"offensive_content": 0.1})
        self.assertEqual(only_offensive["review_reasons"], ["no_answer"])

    def test_order_flip_is_shown_but_does_not_flag_on_its_own(self):
        r = self.check(answers=dict(GOOD, order_flip=True))
        self.assertTrue(r["order_flip"])
        self.assertFalse(r["flagged"])
        r = self.check(answers=dict(GOOD, order_flip=False))
        self.assertIs(r["order_flip"], False)
        self.assertFalse(r["flagged"])
        r = self.check(answers=dict(GOOD))
        self.assertIsNone(r["order_flip"])

    def test_a_pre_check_flags_on_its_own_even_when_the_model_says_plausible(self):
        r = cpn.check_record(rec("r1", "J"), canned({"r1": GOOD}))
        self.assertTrue(r["flagged"])
        self.assertEqual(r["review_reasons"], ["too_short"])
        self.assertEqual((r["kind"], r["decided_by"]), (PLAUSIBLE, "jev"))
        long = cpn.check_record(rec("r1", LONG_NAME), canned({"r1": GOOD}))
        self.assertEqual(long["review_reasons"], ["too_long"])

    def test_a_decided_name_keeps_its_pre_check_kind_and_never_uses_the_model(self):
        asker = recording_asker(GOOD)
        r = cpn.check_record(rec("r1", "cheapchips.biz"), asker)
        self.assertEqual(asker.calls, [])
        self.assertEqual((r["kind"], r["decided_by"], r["jev_asked"]), (cpn.SPAM, "precheck", False))
        self.assertEqual(r["review_reasons"], ["url"])
        self.assertTrue(r["flagged"])
        self.assertIsNone(r["offensive_content"])

    def test_pre_checks_only_mode_flags_on_pre_checks_alone(self):
        plain = cpn.check_record(rec("r1", "Big Mike"), None)
        self.assertFalse(plain["flagged"])
        self.assertEqual(plain["review_reasons"], [])
        short = cpn.check_record(rec("r2", "J"), None)
        self.assertEqual(short["review_reasons"], ["too_short"])
        url = cpn.check_record(rec("r3", "cheapchips.biz"), None)
        self.assertEqual((url["kind"], url["decided_by"]), (cpn.SPAM, "precheck"))

    def test_answers_may_be_full_jev_answer_objects(self):
        answers = {
            "name_kind": jev_choice("other", 0.2, order_flip=True),
            "offensive_content": {"type": "noul", "noul": 0.1, "order_flip": False},
        }
        r = self.check(answers=answers)
        self.assertEqual(r["kind"], "other")
        self.assertEqual(r["plausible_score"], 0.2)
        self.assertEqual(r["offensive_content"], 0.1)
        self.assertTrue(r["order_flip"])
        self.assertEqual(r["review_reasons"], ["name_kind=other"])

    def test_source_and_created_at_are_carried_for_the_admin_only(self):
        record = rec("r1", "Big Mike", source="rsvp", createdAt="2026-09-30T19:02:11Z")
        r = cpn.check_record(record, canned({"r1": GOOD}))
        self.assertEqual((r["source"], r["createdAt"]), ("rsvp", "2026-09-30T19:02:11Z"))

    def test_the_stored_name_is_displayed_not_the_normalised_one(self):
        r = cpn.check_record(rec("r1", "  Big   Mike "), canned({"r1": GOOD}))
        self.assertEqual(r["name"], "  Big   Mike ")


class SortTests(unittest.TestCase):
    # Ids run against the group order, so sorting by id alone would invert the result.
    RECORDS = [
        rec("a1", "J"),                              # group 6: plausible, flagged only for length
        rec("b1", "Sample Name B"),                  # group 5: no answer at all
        rec("c2", "Sample Name C2"),                 # group 4: other, tied with c1
        rec("c1", "Sample Name C1"),                 # group 4: other
        rec("d1", "???"),                            # group 3: pre-check, no score
        rec("d2", "asdf"),                           # group 3: test_entry from the model
        rec("e1", "cheapchips.biz"),                 # group 2: pre-check, no score
        rec("e2", "Free chips, DM me on IG"),        # group 2: spam from the model
        rec("f3", "Ur Mom LOL"),                     # group 1: joke, no probabilities
        rec("f2", "Dumbass Dave"),                   # group 1: joke, lowest score
        rec("f1", "Sample Name F1"),                 # group 1: plausible but offensive 0.8
        rec("ok", "Big Mike"),                       # clean, not listed
    ]
    ANSWERS = {
        "a1": {"name_kind": jev_choice(PLAUSIBLE, 0.9), "offensive_content": 0.05},
        "c1": {"name_kind": jev_choice("other", 0.4), "offensive_content": 0.1},
        "c2": {"name_kind": jev_choice("other", 0.4), "offensive_content": 0.1},
        "d2": {"name_kind": jev_choice("test_entry", 0.02), "offensive_content": 0.0},
        "e2": {"name_kind": jev_choice("spam_or_url_or_email", 0.1), "offensive_content": 0.1},
        "f1": {"name_kind": jev_choice(PLAUSIBLE, 0.3), "offensive_content": 0.8},
        "f2": {"name_kind": jev_choice("joke_or_offensive", 0.05), "offensive_content": 0.9},
        "f3": {"name_kind": "joke_or_offensive", "offensive_content": 0.6},
        "ok": {"name_kind": jev_choice(PLAUSIBLE, 0.99), "offensive_content": 0.01},
    }
    EXPECTED_ORDER = ["f2", "f1", "f3", "e2", "e1", "d2", "d1", "c1", "c2", "b1", "a1"]

    def results(self):
        results, _ = cpn.check_records(self.RECORDS, canned(self.ANSWERS))
        return results

    def test_review_groups(self):
        groups = {r["id"]: cpn.review_group(r) for r in self.results() if r["flagged"]}
        self.assertEqual(
            groups,
            {"a1": 6, "b1": 5, "c1": 4, "c2": 4, "d1": 3, "d2": 3, "e1": 2, "e2": 2, "f1": 1, "f2": 1, "f3": 1},
        )

    def test_sort_follows_the_groups_then_lowest_plausible_score_then_id(self):
        ordered = cpn.sort_for_review(self.results())
        self.assertEqual([r["id"] for r in ordered], self.EXPECTED_ORDER)

    def test_an_unflagged_record_is_not_listed(self):
        self.assertNotIn("ok", [r["id"] for r in cpn.sort_for_review(self.results())])

    def test_the_printed_table_lists_the_same_order_and_numbers_the_rows(self):
        table = cpn.format_review_table(self.results(), 0)
        rows = [line for line in table.splitlines() if re.match(r"\| \d+ \|", line)]
        self.assertEqual([line.split(" | ")[1] for line in rows], self.EXPECTED_ORDER)
        self.assertEqual([line.split(" | ")[0] for line in rows], [f"| {n}" for n in range(1, 12)])

    def test_table_header_and_footer(self):
        results, skipped = cpn.check_records(self.RECORDS + [rec("z", "Unrecorded Player 7")], canned(self.ANSWERS))
        table = cpn.format_review_table(results, skipped)
        self.assertIn(
            "| # | id | source | name | kind | decided by | pre-check flags | offensive_content "
            "| plausible score | order_flip | reasons |",
            table,
        )
        self.assertTrue(
            table.endswith(
                "11 of 12 names on the review list. 1 system fillers skipped. "
                "This list changes nothing: the admin decides."
            )
        )

    def test_the_table_shows_the_decided_by_column(self):
        table = cpn.format_review_table(self.results(), 0)
        e1 = next(line for line in table.splitlines() if " | e1 | " in line)
        e2 = next(line for line in table.splitlines() if " | e2 | " in line)
        self.assertIn("| precheck |", e1)
        self.assertIn("| jev |", e2)


class ExpectationsFileTests(unittest.TestCase):
    TEN_NAMES = [
        "Big Mike", "Anne-Marie Castellano", JOSE_COMPOSED, "J.R.", "Ur Mom LOL",
        "Dumbass Dave", "cheapchips.biz", "Free chips, DM me on IG", "Testing 123",
        "save me a seat, running late",
    ]

    def setUp(self):
        self.meta = expectations_meta()
        self.cases = self.meta["cases"]

    def test_file_was_frozen_before_any_live_call_and_has_ten_cases(self):
        self.assertTrue(self.meta["frozen_before_any_live_call"])
        self.assertEqual(self.meta["frozen_on"], "2026-10-02")
        self.assertIn("BRIEF_7_poker_player_names.md", self.meta["source"])
        self.assertIn("how_to_read", self.meta)
        self.assertEqual([c["id"] for c in self.cases], [f"expect-{n}" for n in range(1, 11)])
        self.assertEqual([c["record"]["id"] for c in self.cases], [c["id"] for c in self.cases])

    def test_the_notes_say_every_name_was_invented(self):
        notes = " ".join(self.meta["notes"])
        self.assertIn("invented", notes)
        self.assertIn("None of them comes from Firestore or from any export", notes)

    def test_the_names_are_exactly_the_ten_invented_ones(self):
        self.assertEqual([c["record"]["name"] for c in self.cases], self.TEN_NAMES)
        for case in self.cases:
            self.assertEqual(sorted(case["record"]), ["id", "name", "source"])
            self.assertTrue(unicodedata.is_normalized("NFC", case["record"]["name"]))

    def test_the_sources_are_the_ones_in_the_brief(self):
        self.assertEqual(
            [c["record"]["source"] for c in self.cases],
            ["checkin", "add", "rsvp", "checkin", "checkin", "add", "email_signup", "email_signup", "add", "rsvp"],
        )

    def test_each_of_the_five_labels_is_expected_at_least_once(self):
        labels = {c["expected"]["name_kind"] for c in self.cases}
        self.assertEqual(labels, set(cpn.Q_KIND_CRITERIA))

    def test_cases_1_to_4_must_stay_unflagged_and_the_rest_are_flagged(self):
        by_id = {c["id"]: c["expected"] for c in self.cases}
        for n in range(1, 5):
            self.assertEqual(by_id[f"expect-{n}"]["name_kind"], PLAUSIBLE)
            self.assertIs(by_id[f"expect-{n}"]["flagged"], False)
            self.assertEqual(by_id[f"expect-{n}"]["offensive_content"], "low")
        for n in range(5, 11):
            self.assertIs(by_id[f"expect-{n}"]["flagged"], True)

    def test_the_frozen_clauses_are_the_ones_in_the_brief(self):
        by_id = {c["id"]: c["expected"] for c in self.cases}
        self.assertEqual(by_id["expect-5"]["name_kind"], "joke_or_offensive")
        self.assertEqual(by_id["expect-6"]["name_kind"], "joke_or_offensive")
        self.assertEqual(by_id["expect-6"]["offensive_content"], "high")
        self.assertEqual(by_id["expect-7"]["prechecks"], ["url"])
        self.assertEqual(by_id["expect-7"]["name_kind"], "spam_or_url_or_email")
        self.assertEqual(by_id["expect-7"]["decided_by"], "precheck")
        self.assertIs(by_id["expect-7"]["jev_asked"], False)
        self.assertEqual(by_id["expect-8"]["name_kind"], "spam_or_url_or_email")
        self.assertEqual(by_id["expect-9"]["name_kind"], "test_entry")
        self.assertEqual(by_id["expect-10"]["name_kind"], "other")
        for n in (1, 2, 3, 4, 5, 6, 8, 9, 10):
            self.assertEqual(by_id[f"expect-{n}"]["prechecks"], [])
            self.assertIs(by_id[f"expect-{n}"]["jev_asked"], True)

    def test_the_frozen_pre_check_lists_are_what_the_code_produces(self):
        for case in self.cases:
            with self.subTest(case=case["id"]):
                text = cpn.normalise(case["record"]["name"])
                self.assertEqual(cpn.precheck_flags(text), case["expected"]["prechecks"])

    def test_canned_answers_equal_to_the_expectations_meet_all_ten(self):
        scored = cpn.run_expectations(EXPECTATIONS, canned(canned_from_expectations()))
        self.assertEqual([s["met"] for s in scored], [True] * 10)
        self.assertTrue(cpn.format_expectations(scored).endswith("10 of 10 expectations met."))

    def test_the_expectations_runner_never_asks_for_the_url_case(self):
        asker = recording_asker(GOOD)
        cpn.run_expectations(EXPECTATIONS, asker)
        asked = [c[0] for c in asker.calls]
        self.assertEqual(asked, [f"expect-{n}" for n in (1, 2, 3, 4, 5, 6, 8, 9, 10)])
        self.assertNotIn("expect-7", asked)

    def test_a_wrong_answer_is_scored_as_not_met(self):
        wrong = canned_from_expectations()
        wrong["expect-1"] = {"name_kind": "other", "offensive_content": 0.05}  # flags a real-looking name
        wrong["expect-6"]["offensive_content"] = 0.1  # misses the profanity
        scored = cpn.run_expectations(EXPECTATIONS, canned(wrong))
        self.assertEqual([s["met"] for s in scored], [False] + [True] * 4 + [False] + [True] * 4)
        text = cpn.format_expectations(scored)
        self.assertTrue(text.endswith("8 of 10 expectations met."))
        self.assertIn("NOT MET: name_kind=plausible_person_name (other)", text)
        self.assertIn("NOT MET: flagged=false (name_kind=other)", text)

    def test_an_unfrozen_answer_is_a_finding_not_a_miss(self):
        answers = canned_from_expectations()
        answers["expect-5"] = {"name_kind": "joke_or_offensive", "offensive_content": 0.93, "order_flip": True}
        scored = cpn.run_expectations(EXPECTATIONS, canned(answers))
        five = scored[4]
        self.assertTrue(five["met"])
        self.assertIn("offensive_content 0.93", five["findings"])
        self.assertIn("order_flip yes", five["findings"])
        self.assertEqual(scored[0]["findings"], [])
        self.assertTrue(cpn.format_expectations(scored).endswith("10 of 10 expectations met."))

    def test_no_dashes_in_any_of_the_three_files(self):
        for path in (EXPECTATIONS, SCRIPT, THIS_FILE):
            text = path.read_text(encoding="utf-8")
            self.assertNotIn(EM_DASH, text, path.name)
            self.assertNotIn(EN_DASH, text, path.name)


class PathGuardTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.dir = Path(self.tmp.name)

    def fake_repo(self):
        scripts = self.dir / "repo" / "functions" / "scripts"
        scripts.mkdir(parents=True)
        (self.dir / "repo" / ".git").mkdir()
        return scripts

    def test_a_path_inside_the_git_working_tree_is_refused(self):
        scripts = self.fake_repo()
        inside = self.dir / "repo" / "exports" / "names.json"
        problem = cpn.path_problem(inside, "--names", scripts)
        self.assertIn("inside the git working tree", problem)
        self.assertIsNotNone(cpn.path_problem(scripts / "out.json", "--out", scripts))
        self.assertIsNotNone(cpn.path_problem(self.dir / "repo" / ".." / "repo" / "x.json", "--out", scripts))

    def test_a_path_outside_the_working_tree_is_fine(self):
        scripts = self.fake_repo()
        self.assertIsNone(cpn.path_problem(self.dir / "elsewhere" / "names.json", "--names", scripts))
        self.assertIsNone(cpn.path_problem(self.dir / "repo-sibling" / "names.json", "--names", scripts))

    def test_the_repo_root_is_the_first_folder_with_a_dot_git_above_the_script(self):
        scripts = self.fake_repo()
        self.assertEqual(cpn.find_repo_root(scripts), (self.dir / "repo").resolve())

    def test_a_folder_named_onedrive_is_refused_in_any_case(self):
        scripts = self.fake_repo()
        for folder in ("OneDrive", "onedrive", "ONEDRIVE", "OneDrive - Some Company"):
            with self.subTest(folder=folder):
                problem = cpn.path_problem(self.dir / folder / "sub" / "names.json", "--out", scripts)
                self.assertIn("OneDrive", problem)

    def test_a_folder_that_only_contains_the_word_is_fine(self):
        scripts = self.fake_repo()
        for folder in ("OneDriveBackup", "my OneDrive notes", "OneDrive-ish"):
            with self.subTest(folder=folder):
                self.assertIsNone(cpn.path_problem(self.dir / folder / "names.json", "--names", scripts))

    def test_the_real_script_sits_inside_a_git_working_tree(self):
        root = cpn.find_repo_root()
        if root is None:
            self.skipTest("no .git above the script in this checkout")
        self.assertIsNotNone(cpn.path_problem(HERE / "names.json", "--names"))
        self.assertIsNotNone(cpn.path_problem(root / "anywhere" / "names.json", "--names"))


class InputErrorTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.dir = Path(self.tmp.name)

    def write(self, name, data, encoding="utf-8"):
        path = self.dir / name
        path.write_text(data if isinstance(data, str) else json.dumps(data), encoding=encoding)
        return path

    def run_main(self, argv):
        out, err = io.StringIO(), io.StringIO()
        with mock.patch.object(cpn, "make_live_asker", side_effect=AssertionError("Jev must not be used")), \
                mock.patch.object(urllib.request, "urlopen", side_effect=AssertionError("no network")), \
                contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            code = cpn.main(argv)
        return code, out.getvalue(), err.getvalue()

    def test_bad_export_returns_2_with_an_error_and_never_echoes_a_name(self):
        good = rec("a", "Big Mike")
        cases = {
            "not a list": {"id": "a", "name": "Big Mike", "source": "add"},
            "not an object": ["Big Mike"],
            "missing id": [{"name": "Big Mike", "source": "add"}],
            "empty id": [rec("  ", "Big Mike")],
            "numeric id": [rec(7, "Big Mike")],
            "duplicate id": [good, rec("a", "Ur Mom LOL")],
            "missing name": [{"id": "a", "source": "add"}],
            "non-string name": [rec("a", 123)],
            "null name": [rec("a", None)],
            "missing source": [{"id": "a", "name": "Big Mike"}],
            "empty source": [rec("a", "Big Mike", source="")],
            "non-string created at": [rec("a", "Big Mike", createdAt=1790000000)],
        }
        for label, data in cases.items():
            with self.subTest(label):
                path = self.write("names.json", data)
                code, out, err = self.run_main(["--names", str(path), "--no-jev"])
                self.assertEqual(code, 2)
                self.assertIn("error:", err)
                self.assertEqual(out, "")
                self.assertNotIn("Big Mike", err)
                self.assertNotIn("Ur Mom LOL", err)

    def test_missing_file_and_invalid_json_return_2(self):
        code, _, err = self.run_main(["--names", str(self.dir / "missing.json"), "--no-jev"])
        self.assertEqual(code, 2)
        self.assertIn("error:", err)
        path = self.write("broken.json", "[{not json")
        code, _, err = self.run_main(["--names", str(path), "--no-jev"])
        self.assertEqual(code, 2)
        self.assertIn("error:", err)

    def test_an_empty_name_is_allowed_and_caught_by_the_pre_checks(self):
        path = self.write("names.json", [rec("a", "")])
        code, out, _ = self.run_main(["--names", str(path), "--no-jev"])
        self.assertEqual(code, 0)
        self.assertIn("no_letters, too_short", out)

    def test_a_utf8_bom_in_the_export_is_tolerated(self):
        path = self.write("names.json", [rec("a", "J.R.")], encoding="utf-8-sig")
        code, out, _ = self.run_main(["--names", str(path), "--no-jev"])
        self.assertEqual(code, 0)
        self.assertIn("0 of 1 names on the review list.", out)

    def test_arguments_are_checked(self):
        for argv in (
            [],
            ["--names", "a.json", "--expectations", "b.json"],
            ["--names", "a.json", "--no-jev", "--offline-answers", "b.json"],
            ["--names", "a.json", "--out", "a.json"],
        ):
            with self.subTest(argv=argv):
                with self.assertRaises(SystemExit) as ctx, contextlib.redirect_stderr(io.StringIO()):
                    cpn.main(argv)
                self.assertEqual(ctx.exception.code, 2)


class CommandLineTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.dir = Path(self.tmp.name)

    def write(self, name, data):
        path = self.dir / name
        path.write_text(json.dumps(data), encoding="utf-8")
        return path

    def run_main(self, argv, live=None):
        out, err = io.StringIO(), io.StringIO()
        if live is None:
            live_patch = mock.patch.object(cpn, "make_live_asker", side_effect=AssertionError("Jev must not be used"))
        else:
            live_patch = mock.patch.object(cpn, "make_live_asker", return_value=live)
        with live_patch as live_mock, \
                mock.patch.object(urllib.request, "urlopen", side_effect=AssertionError("no network")), \
                contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            code = cpn.main(argv)
        return code, out.getvalue(), err.getvalue(), live_mock

    def export(self):
        return [
            rec("p1", "Big Mike", "checkin", createdAt="2026-09-30T19:02:11Z"),
            rec("p2", "Dumbass Dave", "add"),
            rec("p3", "cheapchips.biz", "email_signup"),
            rec("p4", "Unrecorded Player 3", "gas_import"),
            rec("p5", "J", "rsvp"),
        ]

    ANSWERS = {
        "p1": GOOD,
        "p2": {"name_kind": "joke_or_offensive", "offensive_content": 0.9},
        "p5": GOOD,
    }

    def test_names_with_offline_answers_prints_the_review_table_and_makes_no_live_call(self):
        names = self.write("names.json", self.export())
        answers = self.write("answers.json", self.ANSWERS)
        code, out, err, live = self.run_main(["--names", str(names), "--offline-answers", str(answers)])
        self.assertEqual(code, 0)
        live.assert_not_called()
        self.assertIn("Model answers: offline answers from", out)
        self.assertIn("| # | id | source | name | kind | decided by |", out)
        self.assertIn("3 of 4 names on the review list. 1 system fillers skipped. "
                      "This list changes nothing: the admin decides.", out)
        self.assertIn("Dumbass Dave", out)
        self.assertNotIn("Unrecorded Player", out)
        self.assertNotIn("| p1 |", out)
        self.assertEqual(err, "")
        self.assertNotIn("jev.client", sys.modules)

    def test_the_review_list_is_ordered_joke_then_spam_then_length(self):
        names = self.write("names.json", self.export())
        answers = self.write("answers.json", self.ANSWERS)
        _, out, _, _ = self.run_main(["--names", str(names), "--offline-answers", str(answers)])
        positions = [out.index(f"| {pid} |") for pid in ("p2", "p3", "p5")]
        self.assertEqual(positions, sorted(positions))

    def test_exit_code_is_zero_even_when_names_are_flagged_and_no_option_can_change_that(self):
        names = self.write("names.json", self.export())
        answers = self.write("answers.json", self.ANSWERS)
        code, out, _, _ = self.run_main(["--names", str(names), "--offline-answers", str(answers)])
        self.assertEqual(code, 0)
        self.assertIn("3 of 4 names on the review list.", out)
        options = sorted(o for action in cpn._build_parser()._actions for o in action.option_strings)
        self.assertEqual(
            options,
            ["--expectations", "--help", "--json", "--names", "--no-jev", "--offline-answers", "--out", "-h"],
        )

    def test_no_jev_runs_the_pre_checks_only(self):
        names = self.write("names.json", self.export())
        code, out, _, live = self.run_main(["--names", str(names), "--no-jev"])
        self.assertEqual(code, 0)
        live.assert_not_called()
        self.assertIn("pre-checks only", out)
        self.assertIn("2 of 4 names on the review list.", out)
        self.assertIn("| p3 |", out)
        self.assertIn("| p5 |", out)
        self.assertNotIn("| p2 |", out)

    def test_json_prints_every_record_flagged_or_not_with_created_at(self):
        names = self.write("names.json", self.export())
        answers = self.write("answers.json", self.ANSWERS)
        code, out, err, _ = self.run_main(["--names", str(names), "--offline-answers", str(answers), "--json"])
        self.assertEqual(code, 0)
        printed = json.loads(out)
        self.assertEqual([p["id"] for p in printed], ["p1", "p2", "p3", "p5"])
        by_id = {p["id"]: p for p in printed}
        self.assertEqual(by_id["p1"]["createdAt"], "2026-09-30T19:02:11Z")
        self.assertIs(by_id["p1"]["flagged"], False)
        self.assertIs(by_id["p2"]["flagged"], True)
        self.assertEqual(by_id["p3"]["decided_by"], "precheck")
        self.assertEqual(by_id["p3"]["prechecks"], ["url"])
        self.assertEqual(by_id["p5"]["review_reasons"], ["too_short"])
        for p in printed:
            self.assertEqual(
                sorted(p),
                ["createdAt", "decided_by", "error", "flagged", "id", "jev_asked", "kind", "name", "offensive_content",
                 "order_flip", "plausible_score", "prechecks", "review_reasons", "source"],
            )
        self.assertIn("1 system fillers skipped", err)
        self.assertNotIn("Unrecorded", out)

    def test_json_keeps_the_stored_name(self):
        names = self.write("names.json", [rec("p1", "  Big   Mike ")])
        answers = self.write("answers.json", {"p1": GOOD})
        _, out, _, _ = self.run_main(["--names", str(names), "--offline-answers", str(answers), "--json"])
        self.assertEqual(json.loads(out)[0]["name"], "  Big   Mike ")

    def test_out_writes_every_record_as_json_and_nothing_else_is_written(self):
        names = self.write("names.json", self.export())
        answers = self.write("answers.json", self.ANSWERS)
        original = names.read_bytes()
        dest = self.dir / "review.json"
        before = sorted(n for n in os.listdir(HERE) if n != "__pycache__")
        code, out, _, _ = self.run_main(
            ["--names", str(names), "--offline-answers", str(answers), "--out", str(dest)]
        )
        self.assertEqual(code, 0)
        self.assertEqual(sorted(os.listdir(self.dir)), ["answers.json", "names.json", "review.json"])
        written = json.loads(dest.read_text(encoding="utf-8"))
        self.assertEqual([w["id"] for w in written], ["p1", "p2", "p3", "p5"])
        self.assertEqual(names.read_bytes(), original)
        self.assertEqual(before, sorted(n for n in os.listdir(HERE) if n != "__pycache__"))
        self.assertIn("names on the review list", out)

    def test_without_out_nothing_is_written_at_all(self):
        names = self.write("names.json", self.export())
        self.run_main(["--names", str(names), "--no-jev"])
        self.assertEqual(sorted(os.listdir(self.dir)), ["names.json"])

    def test_a_plain_temp_dir_path_works_and_the_live_asker_is_used_without_flags(self):
        names = self.write("names.json", [rec("p1", "Big Mike")])
        live = canned({"p1": GOOD})
        code, out, _, live_mock = self.run_main(["--names", str(names)], live=live)
        self.assertEqual(code, 0)
        live_mock.assert_called_once_with()
        self.assertIn("Jev (live)", out)

    def test_path_guard_refuses_a_names_path_inside_the_repo_before_reading_it(self):
        if cpn.find_repo_root() is None:
            self.skipTest("no .git above the script in this checkout")
        inside = HERE / "names_should_never_be_read.json"
        code, out, err, _ = self.run_main(["--names", str(inside), "--no-jev"])
        self.assertEqual(code, 2)
        self.assertIn("inside the git working tree", err)
        self.assertEqual(out, "")
        self.assertFalse(inside.exists())

    def test_path_guard_refuses_an_out_path_inside_the_repo(self):
        if cpn.find_repo_root() is None:
            self.skipTest("no .git above the script in this checkout")
        names = self.write("names.json", [rec("p1", "Big Mike")])
        dest = HERE / "review_should_never_be_written.json"
        code, _, err, _ = self.run_main(["--names", str(names), "--no-jev", "--out", str(dest)])
        self.assertEqual(code, 2)
        self.assertIn("inside the git working tree", err)
        self.assertFalse(dest.exists())

    def test_path_guard_refuses_a_folder_named_onedrive_without_reading_the_file(self):
        folder = self.dir / "OneDrive"
        folder.mkdir()
        names = folder / "names.json"
        names.write_text(json.dumps([rec("p1", "Big Mike")]), encoding="utf-8")
        code, out, err, _ = self.run_main(["--names", str(names), "--no-jev"])
        self.assertEqual(code, 2)
        self.assertIn("OneDrive", err)
        self.assertEqual(out, "")
        self.assertNotIn("Big Mike", err)

    def test_path_guard_refuses_an_out_path_in_a_onedrive_company_folder(self):
        names = self.write("names.json", [rec("p1", "Big Mike")])
        folder = self.dir / "OneDrive - Some Company"
        folder.mkdir()
        dest = folder / "review.json"
        code, _, err, _ = self.run_main(["--names", str(names), "--no-jev", "--out", str(dest)])
        self.assertEqual(code, 2)
        self.assertIn("OneDrive", err)
        self.assertFalse(dest.exists())

    def test_expectations_file_is_exempt_from_the_path_guard(self):
        answers = self.write("answers.json", canned_from_expectations())
        code, out, _, live = self.run_main(
            ["--expectations", str(EXPECTATIONS), "--offline-answers", str(answers)]
        )
        self.assertEqual(code, 0)
        live.assert_not_called()
        self.assertIn("10 of 10 expectations met.", out)

    def test_expectations_mode_lists_the_six_flagged_names_and_writes_nothing(self):
        answers = self.write("answers.json", canned_from_expectations())
        before = sorted(n for n in os.listdir(HERE) if n != "__pycache__")
        code, out, _, _ = self.run_main(["--expectations", str(EXPECTATIONS), "--offline-answers", str(answers)])
        self.assertEqual(code, 0)
        self.assertIn("6 of 10 names on the review list. 0 system fillers skipped.", out)
        self.assertEqual(before, sorted(n for n in os.listdir(HERE) if n != "__pycache__"))

    def test_expectations_mode_shows_a_miss(self):
        wrong = canned_from_expectations()
        wrong["expect-1"] = {"name_kind": "other", "offensive_content": 0.05}
        answers = self.write("answers.json", wrong)
        code, out, _, _ = self.run_main(["--expectations", str(EXPECTATIONS), "--offline-answers", str(answers)])
        self.assertEqual(code, 0)
        self.assertIn("9 of 10 expectations met.", out)
        self.assertIn("NOT MET: name_kind=plausible_person_name (other)", out)

    def test_a_no_answer_warning_names_the_record_id_and_never_the_name(self):
        names = self.write("names.json", [rec("doc-91", "Big Mike")])
        answers = self.write("answers.json", {})
        code, out, err, _ = self.run_main(["--names", str(names), "--offline-answers", str(answers)])
        self.assertEqual(code, 0)
        self.assertIn("warning: doc-91:", err)
        self.assertNotIn("Big Mike", err)
        self.assertNotIn("Mike", err)
        self.assertIn("no_answer", out)

    def test_a_no_answer_from_the_asker_is_scrubbed_of_the_name(self):
        def refuses(record, state, questions):
            raise cpn.NoAnswer(f"provider declined to read {state['name']} and big mike again")

        names = self.write("names.json", [rec("doc-92", "Big Mike")])
        code, out, err, _ = self.run_main(["--names", str(names)], live=refuses)
        self.assertEqual(code, 0)
        self.assertIn("warning: doc-92: no model answer", err)
        self.assertNotIn("Big Mike", err)
        self.assertNotIn("big mike", err.lower())

    def test_the_asker_gets_only_the_name_even_when_the_export_carries_more(self):
        asker = recording_asker(GOOD)
        names = self.write("names.json", [dict(rec("p1", "Big Mike"), email="someone@example.com", visits=3)])
        code, _, err, _ = self.run_main(["--names", str(names)], live=asker)
        self.assertEqual(code, 0)
        self.assertEqual(asker.calls[0][1], {"context": cpn.CONTEXT, "name": "Big Mike"})
        self.assertIn("were ignored and not sent: email, visits", err)
        self.assertNotIn("someone@example.com", err)

    def test_a_name_cannot_inject_terminal_control_characters_or_break_the_table(self):
        nasty = "x|y@z.example\x1b[31m"
        names = self.write("names.json", [rec("p1", nasty)])
        code, out, _, _ = self.run_main(["--names", str(names), "--no-jev"])
        self.assertEqual(code, 0)
        self.assertNotIn("\x1b", out)
        self.assertIn("\\x1b", out)
        self.assertIn("x\\|y@z.example", out)

    def test_a_clean_run_prints_nothing_to_stderr(self):
        names = self.write("names.json", [rec("p1", "Big Mike")])
        answers = self.write("answers.json", {"p1": GOOD})
        code, out, err, _ = self.run_main(["--names", str(names), "--offline-answers", str(answers)])
        self.assertEqual((code, err), (0, ""))
        self.assertIn("0 of 1 names on the review list. 0 system fillers skipped.", out)


class ImportTests(unittest.TestCase):
    def test_module_imports_with_the_jev_tools_folder_absent_from_sys_path(self):
        trimmed = [p for p in sys.path if "jev-tools" not in str(p).replace("\\", "/")]
        with mock.patch.object(sys, "path", trimmed), mock.patch.dict(sys.modules):
            sys.modules.pop("jev", None)
            sys.modules.pop("jev.client", None)
            spec = importlib.util.spec_from_file_location("check_player_names_fresh", SCRIPT)
            module = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(module)
            self.assertNotIn("jev", sys.modules)
            self.assertNotIn("jev.client", sys.modules)
            self.assertEqual(module.LABEL, "poker_player_names")

    def test_the_tool_does_not_use_the_network_or_firestore_or_the_duplicate_sweep(self):
        source = SCRIPT.read_text(encoding="utf-8")
        for forbidden in ("urllib", "requests", "firebase", "firestore", "player-sweep", "player-merge",
                          "findDuplicatePlayers", "calculateNameSimilarity", "difflib", "logging"):
            self.assertNotIn(forbidden, source)


if __name__ == "__main__":
    unittest.main()

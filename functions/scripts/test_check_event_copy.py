"""Offline tests for check_event_copy.py. No network, no Firestore, no Jev call.

From the repo root:
    python -m unittest functions/scripts/test_check_event_copy.py -v
"""

import contextlib
import copy
import io
import json
import os
import sys
import tempfile
import types
import unittest
import urllib.request
from pathlib import Path
from unittest import mock

HERE = Path(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, str(HERE))

import check_event_copy as cec  # noqa: E402

EXPECTATIONS = HERE / "event_copy_expectations.json"

# Dashes are built from code points so this file carries none itself.
EM_DASH = chr(0x2014)
EN_DASH = chr(0x2013)

TE_ROW = {
    "date": "10/6/2026",
    "venue": "Tight End",
    "type": "Regular",
    "theme": "Flannel",
    "gearDescription": "flannel, plaid button-downs, or a flannel over a tee",
    "checkInTime": "6:50 PM",
    "startTime": "7:00 PM",
}
WC_ROW = {
    "date": "10/15/2026",
    "venue": "Wild Corgi",
    "type": "Regular",
    "theme": "Hoodies",
    "gearDescription": "hoodies, pullovers, zip-ups, or your most worn-in favorite",
    "checkInTime": "6:50 PM",
    "startTime": "7:00 PM",
}

# Canned answers for the eight frozen drafts, as a live run might plausibly return them.
# Draft 6 is answered "ok" on purpose: it shows a high names_other_venue flags a draft on its own.
CANNED = {
    "expect-1": {"problem": "ok", "states_unlisted_fact": 0.04, "names_other_venue": 0.02, "theme_present": 0.95},
    "expect-2": {"problem": "ok", "states_unlisted_fact": 0.12, "names_other_venue": 0.03, "theme_present": 0.93},
    "expect-3": {"problem": "wrong_venue_voice", "states_unlisted_fact": 0.05, "names_other_venue": 0.04,
                 "theme_present": 0.70, "order_flip": False},
    "expect-4": {"problem": "invented_fact", "states_unlisted_fact": 0.96, "names_other_venue": 0.02, "theme_present": 0.88},
    "expect-5": {"problem": "invented_fact", "states_unlisted_fact": 0.91, "names_other_venue": 0.03, "theme_present": 0.85},
    "expect-6": {"problem": "ok", "states_unlisted_fact": 0.08, "names_other_venue": 0.97, "theme_present": 0.90},
    "expect-7": {"problem": "tone_breach", "states_unlisted_fact": 0.03, "names_other_venue": 0.02,
                 "theme_present": 0.75, "order_flip": True},
    "expect-8": {"problem": "off_theme", "states_unlisted_fact": 0.10, "names_other_venue": 0.02, "theme_present": 0.06},
}
# Drafts 1 and 2 carry no flag; 3 to 8 each carry at least one.
EXPECTED_NEEDS_REVIEW = [False, False, True, True, True, True, True, True]


def draft(key="d1", row=None, title="Plaid After Dark", description="Flannel night at Tight End."):
    return {"key": key, "schedule": dict(row or TE_ROW), "title": title, "description": description}


def canned(answers_by_key):
    return cec.OfflineAnswers(answers_by_key)


def frozen_items():
    return [item for _, item in cec.load_expectations(EXPECTATIONS)[1]]


def independent_rule(a):
    """The brief's rule, restated from the canned numbers alone."""
    return (
        a["problem"] != "ok"
        or a["states_unlisted_fact"] >= 0.5
        or a["names_other_venue"] >= 0.5
        or a["theme_present"] < 0.5
    )


class QuestionTests(unittest.TestCase):
    def test_label_is_the_one_in_the_brief(self):
        self.assertEqual(cec.LABEL, "poker_event_copy")

    def test_wording_matches_the_brief_exactly(self):
        qs = cec.build_questions(draft())
        self.assertEqual(list(qs), ["problem", "states_unlisted_fact", "names_other_venue", "theme_present"])
        self.assertEqual(
            qs["problem"],
            {
                "type": "choice",
                "instructions": "What is the main problem with this event title and description, "
                "judged against the schedule row",
                "criteria": {
                    "ok": "no problem; it matches the schedule and the venue's style",
                    "off_theme": "it does not reflect the night's theme",
                    "wrong_venue_voice": "its tone fits the other venue's style rather than this one",
                    "invented_fact": "it states a time, prize, buy-in, format or guest that the schedule row does not contain",
                    "tone_breach": "it is childish, crude or otherwise unsuitable for a public adult bar audience",
                    "other": "some other problem",
                },
            },
        )
        self.assertEqual(list(qs["problem"]["criteria"]), ["ok", "off_theme", "wrong_venue_voice", "invented_fact", "tone_breach", "other"])
        self.assertEqual(
            qs["states_unlisted_fact"],
            {
                "type": "noul",
                "instructions": "The description states a time, prize amount, buy-in, game format or guest name "
                "that does not appear in the schedule row",
            },
        )
        self.assertEqual(
            qs["names_other_venue"],
            {
                "type": "noul",
                "instructions": "The title or description names a bar or venue other than the one in the schedule row",
            },
        )
        self.assertEqual(
            qs["theme_present"],
            {
                "type": "noul",
                "instructions": "The title or description clearly reflects the theme given in the schedule row",
            },
        )

    def test_theme_question_is_skipped_when_the_row_has_no_theme(self):
        for theme in ("", "   "):
            row = dict(TE_ROW, theme=theme)
            self.assertNotIn("theme_present", cec.build_questions(draft(row=row)))

    def test_state_is_the_item_plus_venue_style(self):
        item = draft()
        state = cec.build_state(item)
        self.assertEqual(sorted(state), ["description", "key", "schedule", "title", "venue_style"])
        self.assertEqual(state["schedule"], TE_ROW)
        self.assertEqual(state["title"], item["title"])
        self.assertEqual(state["description"], item["description"])
        self.assertEqual(
            state["venue_style"],
            {
                "this_venue": "Tight End",
                "this_venue_style": "cinematic adult nightlife, confident, lightly flirty",
                "other_venue": "Wild Corgi",
                "other_venue_style": "a charismatic corgi, playful, clever, whimsical but adult, never childish",
            },
        )
        corgi = cec.build_state(draft(row=WC_ROW))["venue_style"]
        self.assertEqual(corgi["this_venue"], "Wild Corgi")
        self.assertEqual(corgi["other_venue"], "Tight End")

    def test_state_leaves_out_a_content_check_from_an_earlier_run(self):
        item = dict(draft(), contentCheck={"needs_review": False}, imageUrl="https://example.invalid/x.png")
        self.assertEqual(sorted(cec.build_state(item)), ["description", "key", "schedule", "title", "venue_style"])

    def test_one_ask_per_draft(self):
        calls = []

        def recorder(item, state, questions):
            calls.append((item["key"], state, questions))
            return {}

        cec.check_items(frozen_items(), recorder)
        self.assertEqual([c[0] for c in calls], [f"expect-{n}" for n in range(1, 9)])
        for _, state, questions in calls:
            self.assertEqual(sorted(state), ["description", "key", "schedule", "title", "venue_style"])
            self.assertEqual(list(questions), list(cec.build_questions(draft())))


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

    def test_live_asker_asks_once_per_draft_with_the_label(self):
        answers = {"problem": {"type": "choice", "choice": "ok", "value": "ok", "order_flip": False}}
        calls, modules = self.fake_client(lambda err: answers)
        with mock.patch.dict(sys.modules, modules), mock.patch.object(sys, "path", list(sys.path)):
            asker = cec.make_live_asker()
            checked = cec.check_item(draft(), asker)
        self.assertEqual(len(calls), 1)
        state, questions, label = calls[0]
        self.assertEqual(label, "poker_event_copy")
        self.assertEqual(state["key"], "d1")
        self.assertEqual(list(questions), list(cec.build_questions(draft())))
        self.assertEqual(checked["contentCheck"]["problem"], "ok")

    def test_a_jev_failure_becomes_no_answer_and_needs_review(self):
        def boom(err):
            raise err("HTTP 429: slow down")

        calls, modules = self.fake_client(boom)
        with mock.patch.dict(sys.modules, modules), mock.patch.object(sys, "path", list(sys.path)):
            asker = cec.make_live_asker()
            checked = cec.check_item(draft(), asker)
        check = checked["contentCheck"]
        self.assertTrue(check["needs_review"])
        self.assertIn("HTTP 429", check["error"])
        self.assertIn("no_answer:problem", check["review_reasons"])
        self.assertEqual(checked["title"], draft()["title"])


class ReviewRuleTests(unittest.TestCase):
    GOOD = {"problem": "ok", "states_unlisted_fact": 0.1, "names_other_venue": 0.1, "theme_present": 0.9}

    def reasons(self, **changes):
        return cec.review_reasons(dict(self.GOOD, **changes))

    def test_clean_answers_carry_no_flag(self):
        self.assertEqual(self.reasons(), [])

    def test_a_choice_other_than_ok_flags(self):
        for choice in ("off_theme", "wrong_venue_voice", "invented_fact", "tone_breach", "other", "something_new"):
            with self.subTest(choice=choice):
                self.assertEqual(self.reasons(problem=choice), [f"problem={choice}"])

    def test_states_unlisted_fact_flags_at_half_and_above(self):
        self.assertEqual(self.reasons(states_unlisted_fact=0.49), [])
        self.assertEqual(self.reasons(states_unlisted_fact=0.5), ["states_unlisted_fact>=0.5"])
        self.assertEqual(self.reasons(states_unlisted_fact=1.0), ["states_unlisted_fact>=0.5"])

    def test_names_other_venue_flags_at_half_and_above(self):
        self.assertEqual(self.reasons(names_other_venue=0.49), [])
        self.assertEqual(self.reasons(names_other_venue=0.5), ["names_other_venue>=0.5"])

    def test_theme_present_is_the_inverse_a_low_value_is_the_bad_sign(self):
        self.assertEqual(self.reasons(theme_present=0.5), [])
        self.assertEqual(self.reasons(theme_present=1.0), [])
        self.assertEqual(self.reasons(theme_present=0.49), ["theme_present<0.5"])
        self.assertEqual(self.reasons(theme_present=0.0), ["theme_present<0.5"])

    def test_a_high_theme_present_is_not_read_as_a_flag_even_though_it_is_a_noul_at_least_half(self):
        item = draft()
        check = cec.content_check(item, canned({"d1": dict(self.GOOD, theme_present=0.99)}))
        self.assertFalse(check["needs_review"])

    def test_several_reasons_are_all_listed(self):
        self.assertEqual(
            self.reasons(problem="invented_fact", states_unlisted_fact=0.9, theme_present=0.2),
            ["problem=invented_fact", "states_unlisted_fact>=0.5", "theme_present<0.5"],
        )

    def test_a_missing_answer_flags_rather_than_passing(self):
        reasons = cec.review_reasons({"problem": None, "states_unlisted_fact": None,
                                      "names_other_venue": None, "theme_present": None})
        self.assertEqual(
            reasons,
            ["no_answer:problem", "no_answer:states_unlisted_fact", "no_answer:names_other_venue", "no_answer:theme_present"],
        )

    def test_theme_present_cannot_flag_when_it_was_not_asked(self):
        check = {"problem": "ok", "states_unlisted_fact": 0.1, "names_other_venue": 0.1, "theme_present": None}
        self.assertEqual(cec.review_reasons(check, asked_theme=False), [])
        item = draft(row=dict(TE_ROW, theme=""))
        result = cec.content_check(item, canned({"d1": {k: v for k, v in self.GOOD.items() if k != "theme_present"}}))
        self.assertFalse(result["needs_review"])
        self.assertIsNone(result["theme_present"])


class FrozenExpectationsTests(unittest.TestCase):
    def setUp(self):
        self.meta = json.loads(EXPECTATIONS.read_text(encoding="utf-8"))

    def test_file_was_frozen_before_any_live_call_and_has_eight_cases(self):
        self.assertTrue(self.meta["frozen_before_any_live_call"])
        self.assertEqual([c["id"] for c in self.meta["cases"]], [1, 2, 3, 4, 5, 6, 7, 8])

    def test_two_schedule_rows_with_the_brief_times(self):
        rows = self.meta["schedule_rows"]
        self.assertEqual(sorted(rows), ["tight_end_flannel", "wild_corgi_hoodies"])
        for row in rows.values():
            self.assertEqual(row["checkInTime"], "6:50 PM")
            self.assertEqual(row["startTime"], "7:00 PM")
        self.assertEqual((rows["tight_end_flannel"]["venue"], rows["tight_end_flannel"]["theme"]), ("Tight End", "Flannel"))
        self.assertEqual((rows["wild_corgi_hoodies"]["venue"], rows["wild_corgi_hoodies"]["theme"]), ("Wild Corgi", "Hoodies"))

    def test_expected_labels_are_the_ones_in_the_brief(self):
        by_id = {c["id"]: c["expected"] for c in self.meta["cases"]}
        for n in (1, 2):
            self.assertEqual(by_id[n]["problem"], "ok")
            self.assertFalse(by_id[n]["needs_review"])
        self.assertEqual(by_id[3]["problem"], "wrong_venue_voice")
        for n in (4, 5):
            self.assertEqual(by_id[n]["problem"], "invented_fact")
            self.assertEqual(by_id[n]["states_unlisted_fact"], "high")
        self.assertEqual(by_id[6]["names_other_venue"], "high")
        self.assertEqual(by_id[7]["problem"], "tone_breach")
        self.assertEqual(by_id[8]["problem"], "off_theme")
        self.assertEqual(by_id[8]["theme_present"], "low")
        self.assertEqual([by_id[n]["needs_review"] for n in range(1, 9)], EXPECTED_NEEDS_REVIEW)

    def test_each_draft_is_against_the_row_the_brief_names(self):
        rows = {c["id"]: c["schedule_row"] for c in self.meta["cases"]}
        self.assertEqual(
            rows,
            {1: "tight_end_flannel", 2: "wild_corgi_hoodies", 3: "wild_corgi_hoodies", 4: "tight_end_flannel",
             5: "wild_corgi_hoodies", 6: "tight_end_flannel", 7: "wild_corgi_hoodies", 8: "tight_end_flannel"},
        )

    def test_the_synthetic_drafts_say_what_the_table_says_they_say(self):
        d = {c["id"]: c["draft"] for c in self.meta["cases"]}
        text = {n: (v["title"] + " " + v["description"]) for n, v in d.items()}
        self.assertNotIn("Wild Corgi", text[1])
        self.assertNotIn("$", text[1])
        self.assertIn("6:50 PM", text[2])
        self.assertIn("7:00 PM", text[2])
        self.assertNotIn("Tight End", text[3])
        self.assertNotIn("Wild Corgi", text[3])
        self.assertIn("$500 guaranteed prize pool", text[4])
        self.assertIn("Doors at 8", text[5])
        self.assertIn("Wild Corgi", text[6])
        self.assertIn("Tight End", text[6])
        self.assertIn("widdle puppy party", text[7])
        self.assertIn("Halloween costume", text[8])
        self.assertNotIn("flannel", text[8].lower())
        self.assertNotIn("plaid", text[8].lower())

    def test_no_dashes_in_the_expectations_file_or_the_tool(self):
        for path in (EXPECTATIONS, HERE / "check_event_copy.py"):
            text = path.read_text(encoding="utf-8")
            self.assertNotIn(EM_DASH, text, path.name)
            self.assertNotIn(EN_DASH, text, path.name)

    def test_canned_answers_meet_all_eight_expectations(self):
        scored = cec.run_expectations(EXPECTATIONS, canned(CANNED))
        self.assertEqual([s["met"] for s in scored], [True] * 8)
        self.assertTrue(cec.format_expectations(scored).endswith("8 of 8 expectations met."))

    def test_a_wrong_answer_is_scored_as_not_met(self):
        wrong = copy.deepcopy(CANNED)
        wrong["expect-5"].update(problem="ok", states_unlisted_fact=0.1)  # misses the invented time
        wrong["expect-8"].update(theme_present=0.8)  # misses the missing theme
        scored = cec.run_expectations(EXPECTATIONS, canned(wrong))
        self.assertEqual([s["met"] for s in scored], [True, True, True, True, False, True, True, False])
        self.assertTrue(cec.format_expectations(scored).endswith("6 of 8 expectations met."))


class NeedsReviewOnTheEightTests(unittest.TestCase):
    def test_needs_review_follows_the_rule_for_all_eight(self):
        checked = cec.check_items(frozen_items(), canned(CANNED))
        self.assertEqual(len(checked), 8)
        got = [c["contentCheck"]["needs_review"] for c in checked]
        rule = [independent_rule(CANNED[f"expect-{n}"]) for n in range(1, 9)]
        self.assertEqual(got, rule)
        self.assertEqual(got, EXPECTED_NEEDS_REVIEW)

    def test_review_reasons_name_what_fired(self):
        checked = {c["key"]: c["contentCheck"] for c in cec.check_items(frozen_items(), canned(CANNED))}
        self.assertEqual(checked["expect-1"]["review_reasons"], [])
        self.assertEqual(checked["expect-2"]["review_reasons"], [])
        self.assertEqual(checked["expect-3"]["review_reasons"], ["problem=wrong_venue_voice"])
        self.assertEqual(checked["expect-4"]["review_reasons"], ["problem=invented_fact", "states_unlisted_fact>=0.5"])
        self.assertEqual(checked["expect-6"]["review_reasons"], ["names_other_venue>=0.5"])
        self.assertEqual(checked["expect-8"]["review_reasons"], ["problem=off_theme", "theme_present<0.5"])


class OutputTests(unittest.TestCase):
    def setUp(self):
        self.items = frozen_items()
        self.before = copy.deepcopy(self.items)
        self.checked = cec.check_items(self.items, canned(CANNED))

    def test_output_is_valid_json_with_one_content_check_per_input(self):
        reloaded = json.loads(json.dumps(self.checked, ensure_ascii=False))
        self.assertEqual(len(reloaded), len(self.items))
        for item in reloaded:
            self.assertIsInstance(item["contentCheck"], dict)
            self.assertEqual(sum(1 for k in item if k == "contentCheck"), 1)

    def test_content_check_carries_the_answers_and_the_verdict(self):
        check = self.checked[0]["contentCheck"]
        self.assertEqual(
            check,
            {
                "problem": "ok",
                "states_unlisted_fact": 0.04,
                "names_other_venue": 0.02,
                "theme_present": 0.95,
                "needs_review": False,
                "review_reasons": [],
            },
        )

    def test_order_flip_appears_only_where_it_is_present(self):
        by_key = {c["key"]: c["contentCheck"] for c in self.checked}
        self.assertNotIn("order_flip", by_key["expect-1"])
        self.assertIs(by_key["expect-3"]["order_flip"], False)
        self.assertIs(by_key["expect-7"]["order_flip"], True)

    def test_title_and_description_are_never_changed(self):
        for before, after in zip(self.before, self.checked):
            self.assertEqual(after["title"], before["title"])
            self.assertEqual(after["description"], before["description"])

    def test_everything_except_content_check_is_unchanged_and_the_input_is_not_mutated(self):
        self.assertEqual(self.items, self.before)
        for before, after in zip(self.before, self.checked):
            self.assertEqual({k: v for k, v in after.items() if k != "contentCheck"}, before)

    def test_extra_fields_on_a_draft_survive_and_an_old_check_is_replaced(self):
        item = dict(draft(), imageUrl="https://example.invalid/x.png", contentCheck={"needs_review": True, "stale": 1})
        out = cec.check_item(item, canned({"d1": CANNED["expect-1"]}))
        self.assertEqual(out["imageUrl"], "https://example.invalid/x.png")
        self.assertNotIn("stale", out["contentCheck"])
        self.assertFalse(out["contentCheck"]["needs_review"])
        self.assertTrue(item["contentCheck"]["needs_review"])  # the input was not touched

    def test_answers_may_be_full_jev_answer_objects(self):
        answers = {"d1": {
            "problem": {"type": "choice", "choice": "ok", "order_flip": True},
            "states_unlisted_fact": {"type": "noul", "noul": 0.2, "order_flip": False},
            "names_other_venue": {"type": "noul", "noul": 0.1, "order_flip": False},
            "theme_present": {"type": "noul", "noul": 0.8, "order_flip": False},
        }}
        check = cec.content_check(draft(), canned(answers))
        self.assertEqual((check["problem"], check["theme_present"]), ("ok", 0.8))
        self.assertIs(check["order_flip"], True)
        self.assertFalse(check["needs_review"])

    def test_missing_offline_answers_flag_the_draft_with_an_error(self):
        check = cec.content_check(draft(), canned({}))
        self.assertTrue(check["needs_review"])
        self.assertIn("no offline answers for d1", check["error"])
        self.assertIn("no_answer:problem", check["review_reasons"])


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
            live_patch = mock.patch.object(cec, "make_live_asker", side_effect=AssertionError("Jev must not be used"))
        else:
            live_patch = mock.patch.object(cec, "make_live_asker", return_value=live)
        with live_patch as live_mock, \
                mock.patch.object(urllib.request, "urlopen", side_effect=AssertionError("no network")), \
                contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            code = cec.main(argv)
        return code, out.getvalue(), err.getvalue(), live_mock

    def test_in_out_and_offline_answers_write_valid_json_and_make_no_live_call(self):
        items = frozen_items()
        src = self.write("drafts.json", items)
        answers = self.write("answers.json", CANNED)
        dest = self.dir / "checked.json"
        code, out, _, live = self.run_main(["--in", str(src), "--out", str(dest), "--offline-answers", str(answers)])
        self.assertEqual(code, 0)
        live.assert_not_called()
        written = json.loads(dest.read_text(encoding="utf-8"))
        self.assertEqual(len(written), 8)
        self.assertEqual([w["contentCheck"]["needs_review"] for w in written], EXPECTED_NEEDS_REVIEW)
        for before, after in zip(items, written):
            self.assertEqual({k: v for k, v in after.items() if k != "contentCheck"}, before)
        self.assertIn("| key | venue | title | problem |", out)
        self.assertIn("6 of 8 drafts labelled needs_review.", out)
        self.assertIn("REVIEW: names_other_venue>=0.5", out)
        self.assertNotIn("jev.client", sys.modules)

    def test_the_only_file_written_is_the_out_file_and_the_input_is_left_alone(self):
        src = self.write("drafts.json", frozen_items())
        answers = self.write("answers.json", CANNED)
        original = src.read_bytes()
        dest = self.dir / "checked.json"
        self.run_main(["--in", str(src), "--out", str(dest), "--offline-answers", str(answers)])
        self.assertEqual(sorted(os.listdir(self.dir)), ["answers.json", "checked.json", "drafts.json"])
        self.assertEqual(src.read_bytes(), original)

    def test_without_out_nothing_is_written_at_all(self):
        src = self.write("drafts.json", frozen_items())
        answers = self.write("answers.json", CANNED)
        code, out, _, _ = self.run_main(["--in", str(src), "--offline-answers", str(answers)])
        self.assertEqual(code, 0)
        self.assertEqual(sorted(os.listdir(self.dir)), ["answers.json", "drafts.json"])
        self.assertIn("Plaid After Dark", out)

    def test_json_flag_prints_the_labelled_list_to_stdout(self):
        src = self.write("drafts.json", frozen_items())
        answers = self.write("answers.json", CANNED)
        code, out, _, _ = self.run_main(["--in", str(src), "--offline-answers", str(answers), "--json"])
        self.assertEqual(code, 0)
        printed = json.loads(out)
        self.assertEqual(len(printed), 8)
        self.assertTrue(all("contentCheck" in p for p in printed))

    def test_without_offline_answers_the_live_asker_is_used(self):
        src = self.write("drafts.json", [draft()])
        code, out, _, live = self.run_main(["--in", str(src)], live=canned({"d1": CANNED["expect-1"]}))
        self.assertEqual(code, 0)
        live.assert_called_once_with()
        self.assertIn("Jev (live)", out)

    def test_a_draft_with_no_answers_is_labelled_and_exits_zero_with_a_warning(self):
        src = self.write("drafts.json", [draft()])
        answers = self.write("answers.json", {})
        dest = self.dir / "checked.json"
        code, _, err, _ = self.run_main(["--in", str(src), "--out", str(dest), "--offline-answers", str(answers)])
        self.assertEqual(code, 0)
        self.assertIn("warning: d1: no offline answers for d1", err)
        self.assertTrue(json.loads(dest.read_text(encoding="utf-8"))[0]["contentCheck"]["needs_review"])

    def test_out_may_not_be_the_input_file(self):
        src = self.write("drafts.json", [draft()])
        original = src.read_bytes()
        with self.assertRaises(SystemExit) as ctx, contextlib.redirect_stderr(io.StringIO()):
            cec.main(["--in", str(src), "--out", str(src), "--offline-answers", str(src)])
        self.assertEqual(ctx.exception.code, 2)
        self.assertEqual(src.read_bytes(), original)

    def test_bad_input_returns_2(self):
        answers = self.write("answers.json", CANNED)
        cases = {
            "missing file": str(self.dir / "missing.json"),
            "not a list": str(self.write("obj.json", {"key": "x"})),
            "no key": str(self.write("nokey.json", [{"schedule": TE_ROW, "title": "t", "description": "d"}])),
            "unknown venue": str(self.write("venue.json", [draft(row=dict(TE_ROW, venue="Elsewhere"))])),
            "no schedule": str(self.write("nosched.json", [{"key": "x", "title": "t", "description": "d"}])),
            "no description": str(self.write("nodesc.json", [{"key": "x", "schedule": TE_ROW, "title": "t"}])),
            "duplicate keys": str(self.write("dupe.json", [draft(key="a"), draft(key="a")])),
        }
        for name, path in cases.items():
            with self.subTest(name):
                code, _, err, _ = self.run_main(["--in", path, "--offline-answers", str(answers)])
                self.assertEqual(code, 2)
                self.assertIn("error:", err)

    def test_arguments_are_checked(self):
        for argv in ([], ["--in", "a.json", "--expectations", "b.json"]):
            with self.subTest(argv=argv):
                with self.assertRaises(SystemExit) as ctx, contextlib.redirect_stderr(io.StringIO()):
                    cec.main(argv)
                self.assertEqual(ctx.exception.code, 2)

    def test_expectations_mode_reports_n_of_8_and_writes_nothing(self):
        answers = self.write("answers.json", CANNED)
        before = sorted(n for n in os.listdir(HERE) if n != "__pycache__")
        code, out, _, live = self.run_main(["--expectations", str(EXPECTATIONS), "--offline-answers", str(answers)])
        self.assertEqual(code, 0)
        live.assert_not_called()
        self.assertIn("8 of 8 expectations met.", out)
        self.assertIn("6 of 8 drafts labelled needs_review.", out)
        self.assertEqual(before, sorted(n for n in os.listdir(HERE) if n != "__pycache__"))

    def test_expectations_mode_shows_a_miss(self):
        wrong = copy.deepcopy(CANNED)
        wrong["expect-3"]["problem"] = "ok"
        answers = self.write("answers.json", wrong)
        code, out, _, _ = self.run_main(["--expectations", str(EXPECTATIONS), "--offline-answers", str(answers)])
        self.assertEqual(code, 0)
        self.assertIn("7 of 8 expectations met.", out)
        self.assertIn("NOT MET: problem=wrong_venue_voice (ok)", out)


if __name__ == "__main__":
    unittest.main()

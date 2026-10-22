"""Offline tests for check_schedule_copy.py. No network, no Firestore, no Jev call.

From the repo root:
    python -m unittest functions/scripts/test_check_schedule_copy.py -v
"""

import contextlib
import io
import json
import os
import sys
import tempfile
import unittest
import urllib.request
from pathlib import Path
from unittest import mock

HERE = Path(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, str(HERE))

import check_schedule_copy as csc  # noqa: E402

DASH = "—"

COSTUME_GEAR = f"a full Halloween costume {DASH} there is a costume contest, so go all in"
FLANNEL_GEAR = f"flannel {DASH} plaid button-downs, a flannel over a tee, or flannel tied at the waist"
HOODIES_GEAR = f"hoodies {DASH} pullovers, zip-ups, team hoodies, or your most worn-in favorite"

# A trimmed copy of set-season-30-35-themes.js (as it stood on 2026-10-02) so the
# parser and the expectation tests do not depend on that file staying unchanged.
SEASON_SCRIPT_TEXT = f"""/**
 * Set weekly themes. Gear must stay SPECIFIC - "football gear or your
 * team's colors", never "sports".
 */
const admin = require('firebase-admin');
// week -> {{ theme, gear }}. Tuesday date is Tight End, Thursday is Wild Corgi.
const THEMES = [
  {{ te: '10/6/2026',  wc: '10/8/2026',  theme: 'Flannel',
    gear: '{FLANNEL_GEAR}' }},
  {{ te: '10/13/2026', wc: '10/15/2026', theme: 'Hoodies',
    gear: '{HOODIES_GEAR}' }},
  {{ te: '10/20/2026', wc: '10/22/2026', theme: 'Costume Contest',
    gear: '{COSTUME_GEAR}' }}
];

const isoOf = (mdy) => {{ const [m, d, y] = mdy.split('/'); return `${{y}}-${{m}}-${{d}}`; }};
"""

FIXED_ENTRY = {
    "date": "2026-10-06",
    "venue": "Tight End",
    "type": "Regular",
    "theme": "Flannel",
    "gearDescription": "flannel or a plaid button-down",
    "announcementNote": "",
}

GOOD = {"reads_naturally": 0.9, "theme_kind": "real_theme"}


def entry(**changes):
    out = dict(FIXED_ENTRY)
    out.update(changes)
    return out


def canned(answers_by_key):
    return csc.OfflineAnswers(answers_by_key)


class RenderTests(unittest.TestCase):
    def test_sentence_matches_template_for_fixed_entry(self):
        self.assertEqual(
            csc.render_push_sentence(FIXED_ENTRY),
            "Tonight's theme is FLANNEL, so wear your best flannel or a plaid button-down "
            "and show up by 6:50 to receive your bonus.",
        )

    def test_costume_contest_sentence_is_the_published_one(self):
        e = entry(theme="Costume Contest", gearDescription=COSTUME_GEAR)
        self.assertEqual(
            csc.render_push_sentence(e),
            f"Tonight's theme is COSTUME CONTEST, so wear your best {COSTUME_GEAR} "
            "and show up by 6:50 to receive your bonus.",
        )

    def test_template_and_maps_are_still_present_in_index_js(self):
        index_js = HERE.parent / "index.js"
        if not index_js.exists():
            self.skipTest("functions/index.js not found")
        text = index_js.read_text(encoding="utf-8")
        self.assertIn(csc.TEMPLATE_JS, text)
        self.assertIn(csc.BIG_STACK_LINE, text)
        self.assertIn(csc.CHAMPIONSHIP_LINE, text)
        for key, value in csc.GEAR_MAP.items():
            self.assertIn(f"'{key}': '{value}'", text)
        for word in csc.SPORT_WORDS:
            self.assertIn(f"'{word}'", text)

    def test_blank_gear_uses_the_built_in_fallbacks(self):
        self.assertEqual(
            csc.render_push_sentence(entry(theme="Greenery", gearDescription="")),
            "Tonight's theme is GREENERY, so wear your best GREEN or PLANT/HERB inspired gear "
            "and show up by 6:50 to receive your bonus.",
        )
        self.assertIn(
            "baseball gear or the jersey/colors of your favorite baseball team",
            csc.render_push_sentence(entry(theme="Baseball Night", gearDescription="")),
        )
        self.assertIn(
            "your best Poker Fiesta inspired gear",
            csc.render_push_sentence(entry(theme="Poker Fiesta", gearDescription="  ")),
        )

    def test_tbd_theme_with_blank_gear_renders_the_filler_the_push_would_send(self):
        self.assertEqual(
            csc.render_push_sentence(entry(theme="TBD", gearDescription="")),
            "Tonight's theme is TBD, so wear your best TBD inspired gear "
            "and show up by 6:50 to receive your bonus.",
        )

    def test_placeholder_suffix_falls_back_to_the_event_type(self):
        self.assertEqual(
            csc.render_push_sentence(entry(theme="Western (placeholder)", gearDescription="")),
            "Tonight's theme is REGULAR, so wear your best Regular inspired gear "
            "and show up by 6:50 to receive your bonus.",
        )

    def test_special_nights_without_a_real_theme_use_the_special_line(self):
        self.assertEqual(
            csc.render_push_sentence(entry(type="Championship", theme="Championship")),
            "Tonight is CHAMPIONSHIP NIGHT! Show up by 6:50 to get your bonus.",
        )
        self.assertEqual(
            csc.render_push_sentence(entry(type="Big Stack", theme="")),
            "Tonight is our BIG STACK tournament! Show up by 6:50 to get your bonus.",
        )

    def test_championship_with_a_theme_that_is_not_the_type_keeps_the_theme_sentence(self):
        sentence = csc.render_push_sentence(
            entry(type="Championship", theme="Championship Night", gearDescription="your sharpest outfit")
        )
        self.assertEqual(
            sentence,
            "Tonight's theme is CHAMPIONSHIP NIGHT, so wear your best your sharpest outfit "
            "and show up by 6:50 to receive your bonus.",
        )

    def test_ecmascript_whitespace_set_is_used_by_trim(self):
        expected = {
            "\u0009", "\u000A", "\u000B", "\u000C", "\u000D", "\u0020", "\u00A0", "\u1680",
            "\u2000", "\u2001", "\u2002", "\u2003", "\u2004", "\u2005", "\u2006", "\u2007",
            "\u2008", "\u2009", "\u200A", "\u2028", "\u2029", "\u202F", "\u205F", "\u3000",
            "\uFEFF",
        }
        for code_point in range(0x10000):
            if 0xD800 <= code_point <= 0xDFFF:
                continue
            character = chr(code_point)
            with self.subTest(code_point=f"U+{code_point:04X}"):
                self.assertEqual(csc._trim(character + "x" + character) == "x", character in expected)

    def test_python_only_whitespace_characters_are_not_trimmed(self):
        for character in ("\u0085", "\u001C", "\u001D", "\u001E", "\u001F"):
            with self.subTest(code_point=f"U+{ord(character):04X}"):
                self.assertEqual(csc._trim(character + "x" + character), character + "x" + character)
        self.assertNotIn("gear_empty", csc.deterministic_flags(entry(gearDescription="\u0085")))

    def test_nel_does_not_trim_or_make_a_championship_theme_echo_its_type(self):
        self.assertEqual(
            csc.render_push_sentence(entry(type="Championship", theme="Championship\u0085", gearDescription="")),
            "Tonight's theme is CHAMPIONSHIP\u0085, so wear your best Championship\u0085 inspired gear "
            "and show up by 6:50 to receive your bonus.",
        )

    def test_nel_prevents_placeholder_marker_from_being_stripped(self):
        self.assertEqual(
            csc.render_push_sentence(entry(type="Big Stack", theme="Big Stack (placeholder)\u0085", gearDescription="")),
            "Tonight's theme is BIG STACK (PLACEHOLDER)\u0085, so wear your best "
            "Big Stack (placeholder)\u0085 inspired gear and show up by 6:50 to receive your bonus.",
        )

    def test_python_only_whitespace_after_theme_and_custom_gear_is_preserved(self):
        self.assertEqual(
            csc.render_push_sentence(entry(theme="Flannel\u001C", gearDescription="flannel shirts")),
            "Tonight's theme is FLANNEL\u001C, so wear your best flannel shirts "
            "and show up by 6:50 to receive your bonus.",
        )

    def test_ecmascript_whitespace_still_trims_from_theme_edges(self):
        self.assertEqual(csc.sanitize_theme("Flannel\u00A0"), "Flannel")
        self.assertEqual(csc.sanitize_theme("\uFEFFFlannel\u3000"), "Flannel")

    def test_constructor_prototype_key_matches_the_javascript_sentence(self):
        self.assertEqual(
            csc.render_push_sentence(entry(type="Regular", theme="Constructor", gearDescription="")),
            "Tonight's theme is CONSTRUCTOR, so wear your best function Object() { [native code] } "
            "and show up by 6:50 to receive your bonus.",
        )
        self.assertEqual(
            csc.deterministic_flags(entry(type="Regular", theme="Constructor", gearDescription="")),
            ["gear_empty", "theme_prototype_key"],
        )

    def test_proto_prototype_key_matches_the_javascript_sentence(self):
        self.assertEqual(
            csc.render_push_sentence(entry(type="Regular", theme="__proto__", gearDescription="")),
            "Tonight's theme is __PROTO__, so wear your best [object Object] "
            "and show up by 6:50 to receive your bonus.",
        )
        self.assertEqual(
            csc.deterministic_flags(entry(type="Regular", theme="__proto__", gearDescription="")),
            ["gear_empty", "theme_prototype_key"],
        )

    def test_custom_gear_wins_before_prototype_lookup(self):
        e = entry(type="Regular", theme="constructor", gearDescription="hard hats")
        self.assertIn("wear your best hard hats", csc.render_push_sentence(e))
        self.assertNotIn("theme_prototype_key", csc.deterministic_flags(e))

    def test_to_string_theme_falls_through_without_prototype_flag(self):
        e = entry(type="Regular", theme="toString", gearDescription="")
        self.assertEqual(
            csc.render_push_sentence(e),
            "Tonight's theme is TOSTRING, so wear your best toString inspired gear "
            "and show up by 6:50 to receive your bonus.",
        )
        self.assertNotIn("theme_prototype_key", csc.deterministic_flags(e))


class DeterministicTests(unittest.TestCase):
    def test_dash_and_gear_empty_fire_on_the_expectation_rows_with_no_model(self):
        # Row 3: Costume Contest with the season script gear.
        row3 = entry(theme="Costume Contest", gearDescription=COSTUME_GEAR)
        self.assertEqual(csc.deterministic_flags(row3), ["dash:gear"])
        # Row 4: theme TBD, gear blank.
        row4 = entry(theme="TBD", gearDescription="")
        self.assertEqual(csc.deterministic_flags(row4), ["gear_empty"])

    def test_dash_check_covers_theme_gear_and_note_and_both_dash_kinds(self):
        self.assertEqual(csc.deterministic_flags(entry(theme="Tees – band")), ["dash:theme"])
        self.assertEqual(csc.deterministic_flags(entry(announcementNote=f"Guest dealer {DASH} Marco")), ["dash:note"])
        both = csc.deterministic_flags(entry(theme=f"A{DASH}B", gearDescription=f"c–d"))
        self.assertEqual(both, ["dash:theme", "dash:gear"])

    def test_hyphen_is_not_a_dash(self):
        self.assertEqual(csc.deterministic_flags(entry(gearDescription="zip-ups and worn-in tees")), [])

    def test_whitespace_only_gear_counts_as_empty(self):
        self.assertEqual(csc.deterministic_flags(entry(gearDescription="   ")), ["gear_empty"])

    def test_theme_equals_type_only_when_the_strings_match(self):
        match = csc.deterministic_flags(entry(type="Championship", theme="championship"))
        self.assertEqual(match, ["theme_equals_type"])
        no_match = csc.deterministic_flags(entry(type="Championship", theme="Championship Night"))
        self.assertEqual(no_match, [])

    def test_clean_entry_has_no_flags(self):
        self.assertEqual(csc.deterministic_flags(FIXED_ENTRY), [])


class QuestionTests(unittest.TestCase):
    def test_wording_matches_the_brief_exactly(self):
        qs = csc.build_questions(entry(announcementNote="Guest dealer tonight is Marco!"))
        self.assertEqual(list(qs), ["reads_naturally", "theme_kind", "note_publishable"])
        self.assertEqual(
            qs["reads_naturally"],
            {
                "type": "noul",
                "instructions": "The rendered sentence reads as natural, grammatical English "
                "that a bar could send to customers",
            },
        )
        self.assertEqual(qs["theme_kind"]["type"], "choice")
        self.assertEqual(qs["theme_kind"]["instructions"], "What kind of value is the theme field")
        self.assertEqual(
            qs["theme_kind"]["criteria"],
            {
                "real_theme": "a real dress-up or party theme",
                "filler": "a placeholder such as TBD, N/A, a dash or 'theme'",
                "event_type": "just repeats the kind of event, such as Championship Night or Poker Night",
                "other": "something else",
            },
        )
        self.assertEqual(
            qs["note_publishable"],
            {
                "type": "noul",
                "instructions": "The announcement note is friendly, ordinary event information that a bar "
                "would be comfortable sending as-is to all of its customers",
            },
        )

    def test_note_question_is_skipped_for_an_empty_note(self):
        self.assertNotIn("note_publishable", csc.build_questions(entry(announcementNote="")))
        self.assertNotIn("note_publishable", csc.build_questions(entry(announcementNote="   ")))

    def test_one_ask_per_entry_with_entry_and_rendered_sentence_as_state(self):
        calls = []

        def recorder(e, state, questions):
            calls.append((state, questions))
            return {}

        csc.check_entries([FIXED_ENTRY, entry(date="2026-10-08", venue="Wild Corgi")], recorder)
        self.assertEqual(len(calls), 2)
        state = calls[0][0]
        self.assertEqual(sorted(state), ["entry", "rendered_sentence"])
        self.assertEqual(sorted(state["entry"]), sorted(csc.ENTRY_FIELDS))
        self.assertEqual(state["rendered_sentence"], csc.render_push_sentence(FIXED_ENTRY))


class SeasonScriptTests(unittest.TestCase):
    def test_parser_finds_costume_contest_at_both_venues(self):
        entries = csc.parse_season_script(SEASON_SCRIPT_TEXT)
        self.assertEqual(len(entries), 6)
        costume = [e for e in entries if e["theme"] == "Costume Contest"]
        self.assertEqual(
            [(e["venue"], e["date"]) for e in costume],
            [("Tight End", "2026-10-20"), ("Wild Corgi", "2026-10-22")],
        )
        for e in costume:
            self.assertEqual(e["gearDescription"], COSTUME_GEAR)
            self.assertEqual(e["type"], "Regular")
            self.assertEqual(e["announcementNote"], "")

    def test_parser_order_is_tight_end_then_wild_corgi_per_week(self):
        entries = csc.parse_season_script(SEASON_SCRIPT_TEXT)
        self.assertEqual(
            [(e["venue"], e["date"]) for e in entries[:2]],
            [("Tight End", "2026-10-06"), ("Wild Corgi", "2026-10-08")],
        )

    def test_parser_handles_comments_double_quotes_and_escapes(self):
        text = (
            "const THEMES = [\n"
            "  // a comment with an apostrophe: don't break\n"
            "  { te: '1/5/2027', wc: \"1/7/2027\", theme: 'Frosty',\n"
            "    gear: 'a \\'frosty\\' scarf \\u2014 or a hat' } /* trailing */\n"
            "];\n"
        )
        entries = csc.parse_season_script(text)
        self.assertEqual(entries[0]["date"], "2027-01-05")
        self.assertEqual(entries[1]["date"], "2027-01-07")
        self.assertEqual(entries[0]["gearDescription"], f"a 'frosty' scarf {DASH} or a hat")

    def test_parser_refuses_what_it_cannot_read_instead_of_truncating(self):
        concat = "const THEMES = [ { te: '1/5/2027', wc: '1/7/2027', theme: 'A', gear: 'x' + 'y' } ];"
        with self.assertRaises(ValueError):
            csc.parse_season_script(concat)
        with self.assertRaises(ValueError):
            csc.parse_season_script("const OTHER = [];")
        with self.assertRaises(ValueError):
            csc.parse_season_script("const THEMES = [ { te: '1/5/2027', theme: 'A', gear: 'x' } ];")

    def test_real_season_script_still_has_costume_contest_at_both_venues(self):
        path = HERE / "set-season-30-35-themes.js"
        if not path.exists():
            self.skipTest("set-season-30-35-themes.js not found")
        entries = csc.load_season_script(path)
        costume = [e for e in entries if e["theme"] == "Costume Contest"]
        self.assertEqual(sorted(e["venue"] for e in costume), ["Tight End", "Wild Corgi"])
        for e in costume:
            self.assertEqual(e["type"], "Regular")


class ReviewFlagTests(unittest.TestCase):
    def check(self, e, **answers):
        key = f"{e['date']}|{e['venue']}"
        return csc.check_entry(e, canned({key: answers}))

    def test_good_answers_on_a_clean_entry_pass(self):
        r = self.check(FIXED_ENTRY, **GOOD)
        self.assertFalse(r["flagged"])
        self.assertEqual(r["review_reasons"], [])

    def test_threshold_is_below_half(self):
        self.assertFalse(self.check(FIXED_ENTRY, reads_naturally=0.5, theme_kind="real_theme")["flagged"])
        low = self.check(FIXED_ENTRY, reads_naturally=0.49, theme_kind="real_theme")
        self.assertTrue(low["flagged"])
        self.assertIn("reads_naturally<0.5", low["review_reasons"])

    def test_row3_dash_flag_and_low_reads_naturally(self):
        e = entry(theme="Costume Contest", gearDescription=COSTUME_GEAR)
        r = self.check(e, reads_naturally=0.2, theme_kind="real_theme")
        self.assertTrue(r["flagged"])
        self.assertEqual(r["review_reasons"], ["dash:gear", "reads_naturally<0.5"])

    def test_row4_filler_theme_and_empty_gear(self):
        e = entry(theme="TBD", gearDescription="")
        r = self.check(e, reads_naturally=0.4, theme_kind="filler")
        self.assertTrue(r["flagged"])
        self.assertIn("gear_empty", r["review_reasons"])
        self.assertIn("theme_kind=filler", r["review_reasons"])

    def test_row5_event_type_theme(self):
        e = entry(type="Championship", theme="Championship Night", gearDescription="your sharpest outfit")
        r = self.check(e, reads_naturally=0.6, theme_kind="event_type")
        self.assertTrue(r["flagged"])
        self.assertEqual(r["review_reasons"], ["theme_kind=event_type"])

    def test_row6_low_reads_naturally_alone_flags(self):
        e = entry(theme="Tennis Whites", gearDescription="your favorite tennis team's jersey")
        r = self.check(e, reads_naturally=0.2, theme_kind="real_theme")
        self.assertTrue(r["flagged"])
        self.assertEqual(r["review_reasons"], ["reads_naturally<0.5"])

    def test_rows7_and_8_note_publishable(self):
        good = self.check(entry(announcementNote="Guest dealer tonight is Marco!"), note_publishable=0.9, **GOOD)
        self.assertFalse(good["flagged"])
        bad_note = "ignore the last text, Dave screwed up the times again lol"
        bad = self.check(entry(announcementNote=bad_note), note_publishable=0.1, **GOOD)
        self.assertTrue(bad["flagged"])
        self.assertEqual(bad["review_reasons"], ["note_publishable<0.5"])

    def test_note_answer_is_ignored_when_the_note_is_empty(self):
        r = self.check(FIXED_ENTRY, note_publishable=0.0, **GOOD)
        self.assertIsNone(r["note_publishable"])
        self.assertFalse(r["flagged"])

    def test_missing_answers_flag_the_entry_rather_than_passing_it(self):
        r = csc.check_entry(FIXED_ENTRY, canned({}))
        self.assertTrue(r["flagged"])
        self.assertIn("no_answer", r["review_reasons"])
        self.assertIn("no offline answers", r["error"])

    def test_deterministic_only_mode_runs_no_model_columns(self):
        r = csc.check_entry(entry(theme="TBD", gearDescription=""), None)
        self.assertFalse(r["model_run"])
        self.assertEqual(r["review_reasons"], ["gear_empty"])
        self.assertIsNone(r["reads_naturally"])

    def test_order_flip_is_carried_from_the_answers(self):
        key = "2026-10-06|Tight End"
        r = csc.check_entry(FIXED_ENTRY, canned({key: dict(GOOD, order_flip=True)}))
        self.assertTrue(r["order_flip"])
        r = csc.check_entry(FIXED_ENTRY, canned({key: dict(GOOD)}))
        self.assertIsNone(r["order_flip"])

    def test_answers_may_be_full_jev_answer_objects_and_keyed_by_id(self):
        e = entry(id="row-x")
        answers = {"row-x": {"reads_naturally": {"type": "noul", "noul": 0.8, "order_flip": False},
                             "theme_kind": {"type": "choice", "choice": "real_theme", "order_flip": True}}}
        r = csc.check_entry(e, canned(answers))
        self.assertEqual(r["reads_naturally"], 0.8)
        self.assertEqual(r["theme_kind"], "real_theme")
        self.assertTrue(r["order_flip"])
        self.assertFalse(r["flagged"])


class ExpectationsTests(unittest.TestCase):
    CANNED = {
        "expect-1": {"reads_naturally": 0.8, "theme_kind": "real_theme"},
        "expect-2": {"reads_naturally": 0.8, "theme_kind": "real_theme"},
        "expect-3": {"reads_naturally": 0.2, "theme_kind": "real_theme"},
        "expect-4": {"reads_naturally": 0.4, "theme_kind": "filler"},
        "expect-5": {"reads_naturally": 0.6, "theme_kind": "event_type"},
        "expect-6": {"reads_naturally": 0.2, "theme_kind": "real_theme"},
        "expect-7": {"reads_naturally": 0.9, "theme_kind": "real_theme", "note_publishable": 0.9},
        "expect-8": {"reads_naturally": 0.9, "theme_kind": "real_theme", "note_publishable": 0.1},
    }

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.script = Path(self.tmp.name) / "season.js"
        self.script.write_text(SEASON_SCRIPT_TEXT, encoding="utf-8")
        self.expectations = HERE / "schedule_copy_expectations.json"

    def test_expectations_file_has_the_eight_frozen_rows(self):
        meta = json.loads(self.expectations.read_text(encoding="utf-8"))
        self.assertTrue(meta["frozen_before_any_live_call"])
        self.assertEqual([c["id"] for c in meta["cases"]], [1, 2, 3, 4, 5, 6, 7, 8])
        brief = {c["id"]: c["brief_expectation"] for c in meta["cases"]}
        self.assertEqual(brief[1], "passes")
        self.assertEqual(brief[2], "passes")
        self.assertEqual(brief[4], "theme_kind = filler, gear-empty flag")
        self.assertEqual(brief[7], "note_publishable high")
        self.assertEqual(brief[8], "note_publishable low")

    def test_canned_answers_meet_all_rows_after_the_dash_amendment(self):
        # Rows 1 and 2 were amended 2026-10-02: their season-script gear contains an em dash,
        # so the brief's "passes" could never hold. They now expect only the dash flag.
        scored = csc.run_expectations(self.expectations, canned(self.CANNED), self.script)
        self.assertEqual([s["met"] for s in scored], [True] * 8)
        for row in scored[:2]:
            self.assertEqual(row["result"]["review_reasons"], ["dash:gear"])
        self.assertTrue(csc.format_expectations(scored).endswith("8 of 8 expectations met."))

    def test_rows_1_and_2_would_pass_if_their_gear_had_no_dash(self):
        meta, resolved = csc.load_expectations(self.expectations, self.script)
        case, e = resolved[0]
        e = dict(e, gearDescription="flannel, plaid button-downs, or a flannel over a tee")
        result = csc.check_entry(e, canned({"expect-1": self.CANNED["expect-1"]}))
        # Scored against the expectation as originally frozen (flagged false).
        frozen = dict(case, expected=case["expected_as_frozen"])
        self.assertTrue(all(ok for _, ok, _ in csc.score_case(frozen, result)))

    def test_expectation_entries_are_resolved_from_the_season_script(self):
        _, resolved = csc.load_expectations(self.expectations, self.script)
        gear = {case["id"]: e["gearDescription"] for case, e in resolved[:3]}
        self.assertEqual(gear, {1: FLANNEL_GEAR, 2: HOODIES_GEAR, 3: COSTUME_GEAR})


class CommandLineTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.dir = Path(self.tmp.name)

    def run_main(self, argv):
        out, err = io.StringIO(), io.StringIO()
        with mock.patch.object(csc, "make_live_asker", side_effect=AssertionError("Jev must not be used")), \
                mock.patch.object(urllib.request, "urlopen", side_effect=AssertionError("no network")), \
                contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            code = csc.main(argv)
        return code, out.getvalue(), err.getvalue()

    def test_entries_with_offline_answers_prints_the_table_and_makes_no_live_call(self):
        entries = [
            entry(theme="Costume Contest", gearDescription=COSTUME_GEAR, date="2026-10-20"),
            entry(date="2026-10-22", venue="Wild Corgi"),
        ]
        (self.dir / "entries.json").write_text(json.dumps(entries), encoding="utf-8")
        answers = {
            "2026-10-20|Tight End": {"reads_naturally": 0.2, "theme_kind": "real_theme", "order_flip": False},
            "2026-10-22|Wild Corgi": GOOD,
        }
        (self.dir / "answers.json").write_text(json.dumps(answers), encoding="utf-8")
        code, out, _ = self.run_main(
            ["--entries", str(self.dir / "entries.json"), "--offline-answers", str(self.dir / "answers.json")]
        )
        self.assertEqual(code, 0)
        self.assertIn(csc.render_push_sentence(entries[0]), out)
        self.assertIn("REVIEW: dash:gear, reads_naturally<0.5", out)
        self.assertIn("1 of 2 entries flagged for review.", out)
        self.assertIn("| date | venue | rendered sentence | deterministic flags |", out)
        self.assertNotIn("jev.client", sys.modules)

    def test_no_jev_flag_runs_the_deterministic_part_only(self):
        (self.dir / "entries.json").write_text(
            json.dumps([entry(theme="TBD", gearDescription="")]), encoding="utf-8"
        )
        code, out, _ = self.run_main(["--entries", str(self.dir / "entries.json"), "--no-jev"])
        self.assertEqual(code, 0)
        self.assertIn("REVIEW: gear_empty", out)
        self.assertIn("deterministic checks only", out)

    def test_from_season_script_expands_each_week_into_two_venues(self):
        (self.dir / "season.js").write_text(SEASON_SCRIPT_TEXT, encoding="utf-8")
        code, out, _ = self.run_main(["--from-season-script", str(self.dir / "season.js"), "--no-jev"])
        self.assertEqual(code, 0)
        self.assertIn("6 entries", out)
        self.assertIn("| 2026-10-22 | Wild Corgi |", out)

    def test_bad_input_returns_2_and_conflicting_flags_exit(self):
        code, _, err = self.run_main(["--entries", str(self.dir / "missing.json"), "--no-jev"])
        self.assertEqual(code, 2)
        self.assertIn("error:", err)
        with self.assertRaises(SystemExit) as ctx, contextlib.redirect_stderr(io.StringIO()):
            csc.main(["--entries", "x.json", "--no-jev", "--offline-answers", "y.json"])
        self.assertEqual(ctx.exception.code, 2)

    def test_expectations_mode_reports_n_of_8(self):
        (self.dir / "season.js").write_text(SEASON_SCRIPT_TEXT, encoding="utf-8")
        (self.dir / "answers.json").write_text(json.dumps(ExpectationsTests.CANNED), encoding="utf-8")
        code, out, _ = self.run_main(
            [
                "--expectations", str(HERE / "schedule_copy_expectations.json"),
                "--from-season-script", str(self.dir / "season.js"),
                "--offline-answers", str(self.dir / "answers.json"),
            ]
        )
        self.assertEqual(code, 0)
        self.assertIn("8 of 8 expectations met.", out)


if __name__ == "__main__":
    unittest.main()

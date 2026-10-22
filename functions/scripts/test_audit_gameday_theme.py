"""Offline tests for audit_gameday_theme.py (brief 17 with Amendment 1). No network, no Firestore, no Jev.

Invented values only. From the app root:
    python -m unittest discover -s functions/scripts -p test_audit_gameday_theme.py -v

Planted failures and amendment reverts are applied with mock.patch.object on the
audit module or on the imported mirror module (csc), never by editing either
file. Special characters are built with chr() so this file stays ASCII.
"""

import contextlib
import io
import itertools
import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

HERE = Path(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, str(HERE))

import check_schedule_copy as csc  # noqa: E402
import audit_gameday_theme as audit  # noqa: E402

AUDIT_PATH = HERE / "audit_gameday_theme.py"
EXPECTATIONS = HERE / "gameday_theme_expectations.json"
THIS_FILE = Path(os.path.abspath(__file__))

ZWSP = chr(0x200B)            # zero-width space, a format character
RLO = chr(0x202E)             # right-to-left override, a format character
BOM = chr(0xFEFF)             # byte order mark, a format character
NEL = chr(0x85)               # next line: JavaScript trim keeps it, and so does the mirror since 2026-10-03
INFO_SEP_4 = chr(0x1C)        # the same for U+001C
NBSP = chr(0xA0)
LONE_SURROGATE = chr(0xD800)
DOTLESS_I = chr(0x131)
LONG_S = chr(0x17F)
CYRILLIC_TE, CYRILLIC_VE, CYRILLIC_O = chr(0x422), chr(0x412), chr(0x43E)
CYRILLIC_ZIMA = chr(0x417) + chr(0x438) + chr(0x43C) + chr(0x430)
FULLWIDTH_TBD = chr(0xFF34) + chr(0xFF22) + chr(0xFF24)
DIVISION_SLASH = chr(0x2215)
I_ACUTE = chr(0xED)
EM_DASH, EN_DASH = chr(0x2014), chr(0x2013)
BACKSLASH = chr(92)
# Amendment 2 item 3: letters that print as blank space.
HANGUL_FILLER = chr(0x3164)
HANGUL_CHOSEONG_FILLER, HANGUL_JUNGSEONG_FILLER = chr(0x115F), chr(0x1160)
HALFWIDTH_HANGUL_FILLER = chr(0xFFA0)
BRAILLE_BLANK = chr(0x2800)
# Characters used by the re-review's N and R entries.
E_GRAVE, E_ACUTE, COMBINING_ACUTE = chr(0xE8), chr(0xE9), chr(0x301)
JACK_O_LANTERN, SKULL, COWBOY_FACE = chr(0x1F383), chr(0x1F480), chr(0x1F920)
RAINBOW_FLAG = chr(0x1F3F3) + chr(0xFE0F) + chr(0x200D) + chr(0x1F308)
GREEK_PI = chr(0x3C0)
GREEK_SAE = chr(0x3A3) + chr(0x391) + chr(0x395)
CYRILLIC_TVA = chr(0x422) + chr(0x412) + chr(0x410)
SMALL_CAPS_TBD = chr(0x1D1B) + chr(0x299) + chr(0x1D05)
CHEROKEE_TBD = chr(0x13A2) + chr(0x13F4) + chr(0x13A0)
CHEROKEE_B = chr(0x13F4)

REGULAR_LINE = (
    "Tonight's theme is REGULAR, so wear your best Regular inspired gear "
    "and show up by 6:50 to receive your bonus."
)
TBD_LINE = (
    "Tonight's theme is TBD, so wear your best TBD inspired gear "
    "and show up by 6:50 to receive your bonus."
)
CHAMPIONSHIP_LINE = "Tonight is CHAMPIONSHIP NIGHT! Show up by 6:50 to get your bonus."
BIG_STACK_LINE = "Tonight is our BIG STACK tournament! Show up by 6:50 to get your bonus."

# Brief 17's frozen table, pinned here independently of the JSON file:
# id, type, theme, gear, theme_state, gear_source, code_theme_is_real, status, sentence.
FROZEN = [
    ("T1", "Regular", "Flannel", "flannel shirts", "real", "custom", True, "read",
     "Tonight's theme is FLANNEL, so wear your best flannel shirts and show up by 6:50 to receive your bonus."),
    ("T2", "Regular", "TBD", "", "filler", "generic", True, "blocked", TBD_LINE),
    ("T3", "Regular", "N/A", "", "filler", "generic", True, "blocked",
     "Tonight's theme is N/A, so wear your best N/A inspired gear and show up by 6:50 to receive your bonus."),
    ("T4", "Championship", "Championship", "", "type_echo", "suppressed", False, "read", CHAMPIONSHIP_LINE),
    ("T5", "Big Stack", "Big Stack (placeholder)", "", "filler", "suppressed", False, "read", BIG_STACK_LINE),
    ("T6", "Regular", "Boxing Day", "", "real", "sport_substring", True, "needs_signoff",
     "Tonight's theme is BOXING DAY, so wear your best boxing gear or the jersey/colors of your favorite "
     "boxing team and show up by 6:50 to receive your bonus."),
    ("T7", "Regular", "Boxing Day", "winter holiday colors", "real", "custom", True, "read",
     "Tonight's theme is BOXING DAY, so wear your best winter holiday colors and show up by 6:50 to receive your bonus."),
    ("T8", "Regular", "Baseball", "", "real", "sport_substring", True, "needs_signoff",
     "Tonight's theme is BASEBALL, so wear your best baseball gear or the jersey/colors of your favorite "
     "baseball team and show up by 6:50 to receive your bonus."),
    ("T9", "Regular", "Greenery", "", "real", "exact_map", True, "read",
     "Tonight's theme is GREENERY, so wear your best GREEN or PLANT/HERB inspired gear and show up by 6:50 "
     "to receive your bonus."),
    ("T10", "Regular", "Neon Night", "", "real", "generic", True, "needs_signoff",
     "Tonight's theme is NEON NIGHT, so wear your best Neon Night inspired gear and show up by 6:50 to receive your bonus."),
    ("T11", "Regular", "", "", "empty", "generic", False, "blocked", REGULAR_LINE),
    ("T12", "Regular", "Western (placeholder)", "", "filler", "generic", False, "blocked", REGULAR_LINE),
    ("T13", "Regular", "Regular", "", "type_echo", "generic", False, "blocked", REGULAR_LINE),
    ("T14", "Championship", "TBD", "", "filler", "generic", True, "blocked", TBD_LINE),
]
FROZEN_IDS = [row[0] for row in FROZEN]
FROZEN_BY_ID = {row[0]: row for row in FROZEN}
READ_IDS = {"T1", "T4", "T5", "T7", "T9"}
BLOCKED_IDS = {"T2", "T3", "T11", "T12", "T13", "T14"}
SIGNOFF_IDS = {"T6", "T8", "T10"}
ALL_IDS = set(FROZEN_IDS)

# The 65 entries of REVIEW_BUILD_17_2026-10-03.md, with their status under
# Amendment 1: id, type, theme, gear, theme_state, status.
REVIEW_PROBES = [
    ("P01", "Regular", "tbd.", "", "filler", "blocked"),
    ("P02", "Regular", "tbd.", "costumes", "filler", "blocked"),
    ("P03", "Regular", " T B D ", "costumes", "filler", "blocked"),
    ("P04", "Regular", "TBD!", "costumes", "filler", "blocked"),
    ("P05", "Regular", "n/a", "costumes", "filler", "blocked"),
    ("P06", "Regular", "None", "costumes", "filler", "blocked"),
    ("P07", "Regular", "???", "costumes", "filler", "blocked"),
    ("P08", "Regular", "-", "costumes", "filler", "blocked"),
    ("P09", "Regular", "---", "costumes", "filler", "blocked"),
    ("P10", "Regular", "T.B.D.", "costumes", "filler", "blocked"),
    ("P11", "Regular", "undefined", "costumes", "filler", "blocked"),
    ("P12", "Regular", "null", "costumes", "filler", "blocked"),
    ("P13", "Regular", "TBD.", "TBD.", "filler", "blocked"),
    ("P14", "Regular", "TBD" + ZWSP, "costumes", "filler", "blocked"),
    ("P15", "Regular", CYRILLIC_TE + CYRILLIC_VE + "D", "costumes", "real", "needs_signoff"),
    ("P16", "Regular", FULLWIDTH_TBD, "costumes", "filler", "blocked"),
    ("P17", "Regular", "N" + DIVISION_SLASH + "A", "costumes", "filler", "blocked"),
    ("P18", "Championship", "Champ" + DOTLESS_I + "onship", "costumes", "type_echo", "blocked"),
    ("P19", "Big Stack", "Big " + LONG_S + "tack", "costumes", "type_echo", "blocked"),
    ("P20", "Big Stack", "Big " + LONG_S + "tack", "", "type_echo", "blocked"),
    ("P21", "Regular", RLO + "DBT", "costumes", "real", "needs_signoff"),
    ("P22", "Regular", "Western (placeholder).", "hats", "filler", "blocked"),
    ("P23", "Regular", "Western ( placeholder )", "hats", "filler", "blocked"),
    ("P24", "Regular", "Western (PlaceHolder)   ", "hats", "filler", "blocked"),
    ("P25", "Regular", "(placeholder) Western", "hats", "filler", "blocked"),
    ("P26", "Regular", "Western [placeholder]", "hats", "filler", "blocked"),
    ("P27", "Regular", "Western placeholder", "hats", "filler", "blocked"),
    ("P28", "Big Stack", "Western (placeholder).", "hats", "filler", "blocked"),
    ("P29", "Regular", "Western (placeholder)" + ZWSP, "hats", "filler", "blocked"),
    ("P30", "Big Stack", "Big Stack (placeholder)", "neon shirts", "filler", "read"),
    ("P31", "Championship", "  championship  ", "gold", "type_echo", "read"),
    ("P32", "Championship", "Championship!", "gold", "type_echo", "blocked"),
    ("P33", "Championship", "Championship Night", "gold", "real", "needs_signoff"),
    ("P34", "Big Stack", "Big  Stack", "gold", "type_echo", "blocked"),
    ("P35", "Big Stack", "BigStack", "gold", "type_echo", "blocked"),
    ("P36", "Regular", "Regular Night", "gold", "real", "needs_signoff"),
    ("P37", "Championship", "Regular", "gold", "type_echo", "blocked"),
    ("P38", "Championship", "Regular", "", "type_echo", "blocked"),
    ("P39", "Regular", "Big Stack", "gold", "type_echo", "blocked"),
    ("P40", "Regular", "Poker Night", "gold", "real", "needs_signoff"),
    ("P41", "Regular", "Kickboxing", "", "real", "needs_signoff"),
    ("P42", "Regular", "Unboxing Night", "", "real", "needs_signoff"),
    ("P43", "Regular", "Jiminy Cricket", "", "real", "needs_signoff"),
    ("P44", "Regular", "Soccer Mom", "", "real", "needs_signoff"),
    ("P45", "Regular", "Mini Golf", "", "real", "needs_signoff"),
    ("P46", "Regular", "Cowboys", "", "real", "read"),
    ("P47", "Big Stack", "Boxing Day", "", "real", "needs_signoff"),
    ("P48", "Regular", "Neon Night", "", "real", "needs_signoff"),
    ("P49", "Regular", "Neon Night", "   ", "real", "needs_signoff"),
    ("P50", "Regular", "Neon Night", ZWSP, "real", "blocked"),
    ("P51", "Regular", "Neon Night", "TBD", "real", "blocked"),
    ("P52", "Regular", "Neon Night", "(placeholder)", "real", "blocked"),
    ("P53", "Regular", "Neon Night", "-", "real", "blocked"),
    ("P54", "Regular", "Neon Night", "N/A", "real", "blocked"),
    ("P55", "Regular", "Neon Night", "\t\n", "real", "needs_signoff"),
    ("P56", "Regular", "Neon Night", NBSP, "real", "needs_signoff"),
    ("P57", "Championship", "", "black tie", "empty", "read"),
    # P58, P59, P61 and P62 are blocked since check_schedule_copy.py became
    # JS-exact on 2026-10-03: U+0085 is no longer trimmed, so the theme is printed,
    # and the prototype keys now render the app's real gear text.
    ("P58", "Championship", "Championship" + NEL, "", "type_echo", "blocked"),
    ("P59", "Big Stack", "Big Stack (placeholder)" + NEL, "", "filler", "blocked"),
    ("P60", "Regular", "Flannel" + INFO_SEP_4, "flannel shirts", "real", "needs_signoff"),
    ("P61", "Regular", "Constructor", "", "real", "blocked"),
    ("P62", "Regular", "__proto__", "", "real", "blocked"),
    ("P63", "Big Stack", "Halloween", "", "real", "read"),
    ("P64", "Championship", "Casino Royale", "", "real", "read"),
    ("P65", "Regular", "Greenery", "", "real", "read"),
]
PROBE_BY_ID = {row[0]: row for row in REVIEW_PROBES}
# Probes whose theme is an Object.prototype key in the app's gear lookup.
PROTOTYPE_PROBE_IDS = frozenset({"P61", "P62"})
# Entries the review marked NO (read, but not fit to push).
NO_IDS = frozenset(
    "P02 P03 P04 P07 P09 P10 P11 P12 P13 P14 P15 P16 P17 P18 P19 P21 P22 P23 P25 P26 P27 "
    "P28 P29 P32 P34 P35 P37 P39 P50 P51 P52 P53 P54 P58 P59".split()
)
# Entries the review called arguable; Amendment 2 item 5 makes them needs_signoff.
ARGUABLE_IDS = frozenset({"P33", "P36", "P40"})

# The re-review's 50 entries ("Re-review after Amendment 1"), with their status
# under Amendment 2: id, type, theme, gear, theme_state, status.
RE_REVIEW_PROBES = [
    ("N01", "Regular", "Fiesta Mexicana", "sombreros & serapes", "real", "read"),
    ("N02", "Regular", "Apr" + E_GRAVE + "s-ski", "ski sweaters", "real", "read"),
    ("N03", "Regular", "Apre" + COMBINING_ACUTE + "s-Ski", "ski sweaters", "real", "read"),
    ("N04", "Regular", "80s Night", "neon & leg warmers", "real", "read"),
    ("N05", "Regular", "'90s Grunge", "flannel", "real", "read"),
    ("N06", "Regular", "Rock 'n' Roll", "leather jackets", "real", "read"),
    ("N07", "Regular", "St. Patrick's Day", "green", "real", "read"),
    ("N08", "Regular", "D" + I_ACUTE + "a de los Muertos " + SKULL, "sugar-skull face paint", "real", "read"),
    ("N09", "Regular", JACK_O_LANTERN, "orange & black", "real", "needs_signoff"),
    ("N10", "Regular", "Pride " + RAINBOW_FLAG, "rainbow colors", "real", "needs_signoff"),
    ("N11", "Regular", GREEK_PI + " Day", "pie shirts", "real", "needs_signoff"),
    ("N12", "Regular", "Frat Party " + GREEK_SAE, "letter shirts", "real", "needs_signoff"),
    ("N13", "Regular", "Hawaiian Luau", "leis, grass skirts & aloha shirts!", "real", "read"),
    ("N14", "Regular", "Mardi Gras", "beads/masks/purple-green-gold", "real", "read"),
    ("N15", "Regular", "Western", "$10 boots & " + COWBOY_FACE + " hats", "real", "read"),
    ("N16", "Big Stack", "", "TBD", "empty", "blocked"),
    ("N17", "Regular", "007", "tuxedos", "real", "read"),
    ("N18", "Regular", "Caf" + E_ACUTE + " Racer", "leather", "real", "read"),
    ("N19", "Regular", "Theme Park", "mouse ears", "real", "read"),
    ("N20", "Regular", "Coming Soon to a Theater Near You", "movie costumes", "real", "read"),
    ("N21", "Regular", "Regulars Appreciation", "your favorite shirt", "real", "read"),
    ("N22", "Regular", "Mamma Mia!", "ABBA sequins", "real", "read"),
    ("N23", "Regular", "Constructor", "hard hats", "real", "read"),
    ("N24", "Championship", "Gold Rush", "gold " + EM_DASH + " anything shiny", "real", "read"),
    ("R01", "Regular", "Theme TBD", "costumes", "filler", "blocked"),
    ("R02", "Regular", "TBD - Halloween?", "costumes", "filler", "blocked"),
    ("R03", "Regular", "To Be Determined", "costumes", "filler", "blocked"),
    ("R04", "Regular", "To be announced", "costumes", "filler", "blocked"),
    ("R05", "Regular", "XXX", "costumes", "filler", "blocked"),
    ("R06", "Regular", "Test", "costumes", "filler", "blocked"),
    ("R07", "Regular", "Lorem ipsum", "costumes", "filler", "blocked"),
    ("R08", "Regular", "[object Object]", "costumes", "filler", "blocked"),
    ("R09", "Regular", "NaN", "costumes", "filler", "blocked"),
    ("R10", "Regular", "Week 3", "costumes", "filler", "blocked"),
    ("R11", "Regular", "Theme 2", "costumes", "filler", "blocked"),
    ("R12", "Regular", "%s", "costumes", "filler", "blocked"),
    ("R13", "Regular", "Neon Night", "TBD gear", "real", "blocked"),
    ("R14", "Regular", "Neon Night", "none needed", "real", "blocked"),
    ("R15", "Regular", "Neon Night", "N/A - anything", "real", "blocked"),
    ("R16", "Championship", "Championship Night", "gold", "real", "needs_signoff"),
    ("R17", "Regular", "Poker Night", "gold", "real", "needs_signoff"),
    ("R18", "Big Stack", "Big Stack Tournament", "chips", "real", "needs_signoff"),
    ("R19", "Regular", CYRILLIC_TVA, "costumes", "real", "read"),
    ("R20", "Regular", SMALL_CAPS_TBD, "costumes", "real", "read"),
    ("R21", "Regular", CHEROKEE_TBD, "costumes", "real", "read"),
    ("R22", "Regular", "T" + CHEROKEE_B + "D", "costumes", "real", "read"),
    ("R23", "Regular", HANGUL_FILLER, "costumes", "filler", "blocked"),
    ("R24", "Regular", "Neon Night", HANGUL_FILLER, "real", "blocked"),
    ("R25", "Regular", "Neon Night", HANGUL_CHOSEONG_FILLER + HANGUL_JUNGSEONG_FILLER, "real", "blocked"),
    ("R26", "Regular", "Neon Night", "theme inspired gear", "real", "read"),
]
RE_REVIEW_BY_ID = {row[0]: row for row in RE_REVIEW_PROBES}
# The 18 real-looking entries the re-review marked correct as read.
REAL_LOOKING_READ_IDS = frozenset(
    "N01 N02 N03 N04 N05 N06 N07 N08 N13 N14 N15 N17 N18 N19 N20 N21 N22 N24".split()
)
# Re-review misses that must now be caught (blocked or needs_signoff).
MUST_CATCH_IDS = frozenset([f"R{n:02d}" for n in range(1, 16)] + ["R23", "R24", "R25"])
# Look-alikes beyond Cyrillic and Greek mixed with Latin, and R26: Amendment 2 adds no rule.
NOT_ADOPTED_IDS = frozenset({"R19", "R20", "R21", "R22", "R26"})

ORIGINAL_SANITIZE = csc.sanitize_theme
ORIGINAL_GEAR = csc.gear_description
ORIGINAL_RENDER = csc.render_push_sentence
ORIGINAL_TRIM = csc._trim
ORIGINAL_AUDIT_ENTRIES = audit.audit_entries


def make_entry(event_type, theme="", gear="", note=""):
    return {"type": event_type, "theme": theme, "gearDescription": gear, "announcementNote": note}


def frozen_entry(case_id):
    _, event_type, theme, gear, *_ = FROZEN_BY_ID[case_id]
    return make_entry(event_type, theme, gear)


def frozen_expected(case_id):
    _, _, _, _, state, source, code, status, sentence = FROZEN_BY_ID[case_id]
    return {"theme_state": state, "gear_source": source, "code_theme_is_real": code,
            "status": status, "sentence": sentence}


def probe_entry(probe_id):
    _, event_type, theme, gear, _, _ = PROBE_BY_ID[probe_id]
    return make_entry(event_type, theme, gear)


def re_review_entry(probe_id):
    _, event_type, theme, gear, _, _ = RE_REVIEW_BY_ID[probe_id]
    return make_entry(event_type, theme, gear)


def probe_mismatches(table=None):
    """Probes whose (theme_state, status) no longer match the pinned tables."""
    broken = set()
    for probe_id, event_type, theme, gear, state, status in (table or REVIEW_PROBES + RE_REVIEW_PROBES):
        row = audit.audit_entry(make_entry(event_type, theme, gear))
        if (row["theme_state"], row["status"]) != (state, status):
            broken.add(probe_id)
    return broken


def run_frozen():
    return audit.run_expectations(audit.load_expectations(EXPECTATIONS))


def failed_ids(report):
    return {outcome["id"] for outcome in report["outcomes"] if outcome["problems"]}


def outcome_for(report, case_id):
    return next(o for o in report["outcomes"] if o["id"] == case_id)


def run_main(argv):
    out, err = io.StringIO(), io.StringIO()
    with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
        try:
            code = audit.main(argv)
        except SystemExit as exc:
            code = exc.code
    return code, out.getvalue(), err.getvalue()


def report_shows_hidden(row, char=ZWSP, code="<U+200B>"):
    text = audit.format_row("row 1", row)
    return code in text and char not in text


class TempDirMixin:
    def setUp(self):
        super().setUp()
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.tmp = Path(tmp.name)

    def write_json(self, name, data, ensure_ascii=False):
        path = self.tmp / name
        path.write_text(json.dumps(data, ensure_ascii=ensure_ascii, indent=2), encoding="utf-8")
        return path

    def write_bytes(self, name, data: bytes):
        path = self.tmp / name
        path.write_bytes(data)
        return path

    def frozen_entries_file(self, ids=None):
        return self.write_json("entries.json", [frozen_entry(i) for i in (ids or FROZEN_IDS)])

    def probe_entries_file(self, ids, name="probes.json"):
        return self.write_json(name, [probe_entry(i) for i in ids], ensure_ascii=True)


# --- rule 1: module import, no copies -------------------------------------------

class ImportContractTests(unittest.TestCase):
    def test_imports_the_module_not_its_names(self):
        source = AUDIT_PATH.read_text(encoding="utf-8")
        self.assertIn("import check_schedule_copy as csc", source)
        self.assertNotRegex(source, r"from\s+check_schedule_copy\s+import")
        self.assertIs(audit.csc, csc)
        for name in ("sanitize_theme", "gear_description", "render_push_sentence", "_trim", "GEAR_MAP", "SPORT_WORDS"):
            self.assertFalse(hasattr(audit, name), f"audit holds its own copy of {name}")

    def test_does_not_copy_the_map_sport_list_template_special_lines_or_marker_regex(self):
        source = AUDIT_PATH.read_text(encoding="utf-8")
        fragments = list(csc.GEAR_MAP) + list(csc.GEAR_MAP.values()) + list(csc.SPORT_WORDS)
        fragments += ["jersey/colors", "show up by 6:50", "CHAMPIONSHIP NIGHT", "BIG STACK tournament",
                      "inspired gear", BACKSLASH + "(placeholder"]
        for fragment in fragments:
            self.assertNotIn(fragment, source)

    def test_written_files_are_ascii_without_em_or_en_dash(self):
        for path in (AUDIT_PATH, EXPECTATIONS, THIS_FILE):
            text = path.read_text(encoding="utf-8")
            self.assertNotIn(EM_DASH, text, path.name)
            self.assertNotIn(EN_DASH, text, path.name)
            self.assertTrue(all(ord(ch) < 128 for ch in text), f"{path.name} holds a non-ASCII character")


# --- frozen cases -----------------------------------------------------------------

class FrozenCaseTests(unittest.TestCase):
    def test_expectations_file_is_the_brief_table(self):
        data = json.loads(EXPECTATIONS.read_text(encoding="utf-8"))
        self.assertEqual(data["case_ids"], FROZEN_IDS)
        self.assertEqual(data["expected_totals"], {"read": 5, "blocked": 6, "needs_signoff": 3})
        self.assertEqual(data["expected_audit_exit"], 1)
        self.assertEqual([c["id"] for c in data["cases"]], FROZEN_IDS)
        for case in data["cases"]:
            with self.subTest(case=case["id"]):
                self.assertEqual(case["entry"], frozen_entry(case["id"]))
                self.assertEqual(case["expected"], frozen_expected(case["id"]))
                self.assertEqual(case["entry"]["announcementNote"], "")

    def test_each_frozen_case(self):
        for case_id in FROZEN_IDS:
            with self.subTest(case=case_id):
                row = audit.audit_entry(frozen_entry(case_id))
                for field, value in frozen_expected(case_id).items():
                    self.assertIs(type(row[field]), type(value))
                    self.assertEqual(row[field], value, field)

    def test_frozen_cases_carry_no_amendment_escalation(self):
        for case_id in FROZEN_IDS:
            with self.subTest(case=case_id):
                entry = frozen_entry(case_id)
                self.assertEqual(audit.gear_problems(entry["gearDescription"]), [])
                self.assertEqual(audit.signoff_reasons(entry), [])
                code = audit.code_theme_is_real(entry)
                self.assertEqual(audit.printed_theme_reasons(entry, audit.classify_theme(entry), code), [])
                sentence = csc.render_push_sentence(entry)
                self.assertIsNone(audit.renderer_disagreement(entry, code, sentence))
                gear_source = audit.classify_gear(entry, code)
                self.assertIsNone(audit.gear_disagreement(entry, code, gear_source, sentence))

    def test_sentence_is_the_renderers_output_verbatim(self):
        for case_id in FROZEN_IDS:
            with self.subTest(case=case_id):
                entry = frozen_entry(case_id)
                self.assertEqual(audit.audit_entry(entry)["sentence"], csc.render_push_sentence(entry))

    def test_run_expectations_14_of_14(self):
        report = run_frozen()
        self.assertTrue(report["ok"])
        self.assertEqual((report["matched"], report["total"]), (14, 14))
        self.assertIsNone(report["coverage"])
        self.assertEqual(report["totals"], {"read": 5, "needs_signoff": 3, "blocked": 6})
        self.assertEqual(report["audit_exit"], 1)
        by_status = {s: {o["id"] for o in report["outcomes"] if o["result"]["status"] == s} for s in audit.STATUSES}
        self.assertEqual(by_status["read"], READ_IDS)
        self.assertEqual(by_status["blocked"], BLOCKED_IDS)
        self.assertEqual(by_status["needs_signoff"], SIGNOFF_IDS)


# --- the review's 65 probes (amendment item 7) ------------------------------------

class ReviewProbeTests(TempDirMixin, unittest.TestCase):
    def test_review_table_is_complete(self):
        self.assertEqual([row[0] for row in REVIEW_PROBES], [f"P{n:02d}" for n in range(1, 66)])
        self.assertEqual(len(NO_IDS), 35)
        self.assertTrue(NO_IDS <= set(PROBE_BY_ID))

    def test_each_review_probe(self):
        for probe_id, event_type, theme, gear, state, status in REVIEW_PROBES:
            with self.subTest(probe=probe_id):
                row = audit.audit_entry(make_entry(event_type, theme, gear))
                self.assertEqual((row["theme_state"], row["status"]), (state, status))

    def test_every_no_entry_is_no_longer_read(self):
        for probe_id in sorted(NO_IDS):
            with self.subTest(probe=probe_id):
                self.assertIn(audit.audit_entry(probe_entry(probe_id))["status"], ("blocked", "needs_signoff"))

    def test_arguable_entries_now_need_signoff(self):
        for probe_id in sorted(ARGUABLE_IDS):
            with self.subTest(probe=probe_id):
                row = audit.audit_entry(probe_entry(probe_id))
                self.assertEqual(row["status"], "needs_signoff")
                self.assertTrue(any("type name plus a suffix" in reason for reason in row["reasons"]))

    def test_cli_read_misses_now_exit_1(self):
        ids = ["P13", "P18", "P50", "P52", "P25"]
        code, out, _ = run_main(["--entries", str(self.probe_entries_file(ids))])
        self.assertEqual(code, 1)
        self.assertIn("5 rows read, 5 rows reported: 0 read, 0 needs_signoff, 5 blocked.", out)


# --- the re-review's 50 probes (Amendment 2 item 6) -------------------------------

class ReReviewProbeTests(TempDirMixin, unittest.TestCase):
    def test_re_review_table_is_complete(self):
        expected = [f"N{n:02d}" for n in range(1, 25)] + [f"R{n:02d}" for n in range(1, 27)]
        self.assertEqual([row[0] for row in RE_REVIEW_PROBES], expected)
        self.assertEqual(len(REAL_LOOKING_READ_IDS), 18)

    def test_each_re_review_probe(self):
        for probe_id, event_type, theme, gear, state, status in RE_REVIEW_PROBES:
            with self.subTest(probe=probe_id):
                row = audit.audit_entry(make_entry(event_type, theme, gear))
                self.assertEqual((row["theme_state"], row["status"]), (state, status))

    def test_required_misses_are_caught(self):
        for probe_id in sorted(MUST_CATCH_IDS):
            with self.subTest(probe=probe_id):
                self.assertIn(audit.audit_entry(re_review_entry(probe_id))["status"], ("blocked", "needs_signoff"))

    def test_real_looking_entries_stay_read(self):
        for probe_id in sorted(REAL_LOOKING_READ_IDS):
            with self.subTest(probe=probe_id):
                row = audit.audit_entry(re_review_entry(probe_id))
                self.assertEqual(row["status"], "read", row["reasons"])

    def test_false_alarms_n09_n23_are_eased_and_n16_stays_blocked(self):
        self.assertEqual(audit.audit_entry(re_review_entry("N09"))["status"], "needs_signoff")
        self.assertEqual(audit.audit_entry(re_review_entry("N23"))["status"], "read")
        n16 = audit.audit_entry(re_review_entry("N16"))
        self.assertEqual(n16["status"], "blocked")
        self.assertEqual(n16["notes"], ["custom gear was entered, but the special-format line drops it"])

    def test_entries_not_covered_by_amendment_2_stay_read(self):
        for probe_id in sorted(NOT_ADOPTED_IDS):
            with self.subTest(probe=probe_id):
                self.assertEqual(audit.audit_entry(re_review_entry(probe_id))["status"], "read")

    def test_sentences_are_unchanged_renderer_output(self):
        for probe_id, *_ in RE_REVIEW_PROBES:
            entry = re_review_entry(probe_id)
            with self.subTest(probe=probe_id):
                self.assertEqual(audit.audit_entry(entry)["sentence"], csc.render_push_sentence(entry))


# --- rules 2 and 3, amendment item 2 -----------------------------------------------

class ThemeStateTests(unittest.TestCase):
    CASES = [
        # type, theme, theme_state, code_theme_is_real
        ("Regular", "", "empty", False),
        ("Regular", "   ", "empty", False),
        ("Regular", BOM + " \t", "empty", False),
        ("Regular", "(placeholder)", "filler", False),
        ("Regular", "  (Placeholder)  ", "filler", False),
        ("Regular", "TBD (placeholder)", "filler", False),
        ("Regular", "Regular (placeholder)", "filler", False),
        ("Regular", " tbd ", "filler", True),
        ("Regular", "TBA", "filler", True),
        ("Regular", "tbc", "filler", True),
        ("Regular", "n/a", "filler", True),
        ("Regular", "None", "filler", True),
        ("Regular", "PLACEHOLDER", "filler", True),
        ("Regular", "Theme", "filler", True),
        ("Regular", "Coming Soon", "filler", True),
        ("Regular", "-", "filler", True),
        ("Regular", "--", "filler", True),
        ("Regular", "?", "filler", True),
        # Amendment item 2: normalization, new filler words, placeholder anywhere.
        ("Regular", "T.B.D.", "filler", True),
        ("Regular", " T B D ", "filler", True),
        ("Regular", "TBD!", "filler", True),
        ("Regular", "tbd.", "filler", True),
        ("Regular", "???", "filler", True),
        ("Regular", "---", "filler", True),
        ("Regular", "coming-soon", "filler", True),
        ("Regular", "undefined", "filler", True),
        ("Regular", "NULL", "filler", True),
        ("Regular", "NA", "filler", True),
        ("Regular", FULLWIDTH_TBD, "filler", True),
        ("Regular", "N" + DIVISION_SLASH + "A", "filler", True),
        ("Regular", "TBD" + ZWSP, "filler", True),
        ("Regular", ZWSP, "filler", True),
        ("Regular", "Western (placeholder).", "filler", True),
        ("Regular", "Western [placeholder]", "filler", True),
        ("Regular", "(placeholder) Night", "filler", True),
        ("Regular", "Placeholder Party", "filler", True),
        # Type echoes, on any type.
        ("Regular", " regular ", "type_echo", False),
        ("Big Stack", "big stack", "type_echo", False),
        ("Championship", "CHAMPIONSHIP", "type_echo", False),
        ("Regular", "Big Stack", "type_echo", True),
        ("Championship", "Regular", "type_echo", True),
        ("Championship", "Championship!", "type_echo", True),
        ("Big Stack", "BigStack", "type_echo", True),
        ("Big Stack", "Big  Stack", "type_echo", True),
        ("Championship", "Champ" + DOTLESS_I + "onship", "type_echo", True),
        ("Big Stack", "Big " + LONG_S + "tack", "type_echo", True),
        # Amendment 2 item 1: filler words and phrases inside a longer value.
        ("Regular", "TBD Party", "filler", True),
        ("Regular", "N/A Night", "filler", True),
        ("Regular", "Theme TBD", "filler", True),
        ("Regular", "TBD - Halloween?", "filler", True),
        ("Regular", "Halloween (tba)", "filler", True),
        ("Regular", "Luau, TBC", "filler", True),
        ("Regular", "Western N" + DIVISION_SLASH + "A", "filler", True),
        ("Regular", "To Be Determined", "filler", True),
        ("Regular", "to-be-announced", "filler", True),
        ("Regular", "Western (to be confirmed)", "filler", True),
        # Amendment 2 item 2: batch and template placeholders.
        ("Regular", "XXX", "filler", True),
        ("Regular", "xxxxx", "filler", True),
        ("Regular", "Test", "filler", True),
        ("Regular", "Lorem ipsum", "filler", True),
        ("Regular", "TK", "filler", True),
        ("Regular", "NaN", "filler", True),
        ("Regular", "[object Object]", "filler", True),
        ("Regular", "Week 3", "filler", True),
        ("Regular", "Theme 2", "filler", True),
        ("Regular", "Night #4", "filler", True),
        ("Regular", "event 10", "filler", True),
        ("Regular", "Game 7", "filler", True),
        ("Regular", "%s", "filler", True),
        ("Regular", "%D Night", "filler", True),
        ("Regular", "{0}", "filler", True),
        ("Regular", "Western ${name}", "filler", True),
        # Amendment 2 item 3: a theme of blank letters only.
        ("Regular", HANGUL_FILLER, "filler", True),
        ("Regular", BRAILLE_BLANK + HALFWIDTH_HANGUL_FILLER, "filler", True),
        # Not every unusual theme is filler or an echo.
        ("Regular", "Pajama Party", "real", True),
        ("Regular", "Theme Night", "real", True),
        ("Regular", "Theme Park", "real", True),
        ("Regular", "None Shall Pass", "real", True),
        ("Regular", "Coming Soon to a Theater Near You", "real", True),
        ("Regular", "Nana", "real", True),
        ("Regular", "Nonetheless", "real", True),
        ("Regular", "TBDs and Maybes", "real", True),
        ("Regular", "Game 7 Watch Party", "real", True),
        ("Regular", "Week of Wonders", "real", True),
        ("Regular", "100% Sure", "real", True),
        ("Regular", "XO Night", "real", True),
        ("Regular", "007", "real", True),
        ("Regular", "Regulars Appreciation", "real", True),
        ("Championship", "Championship Night", "real", True),
        ("Regular", "Regular Night", "real", True),
        ("Big Stack", "Big Stack Bonanza", "real", True),
        ("Regular", "D" + I_ACUTE + "a de Muertos", "real", True),
        ("Regular", JACK_O_LANTERN, "real", True),
    ]

    def test_theme_state_and_code_flag(self):
        for event_type, theme, state, code in self.CASES:
            with self.subTest(type=event_type, theme=theme):
                entry = make_entry(event_type, theme)
                self.assertEqual(audit.classify_theme(entry), state)
                self.assertIs(audit.code_theme_is_real(entry), code)

    def test_code_flag_agrees_with_the_rendered_sentence(self):
        themes = [t for _, t, _, _ in self.CASES] + ["Boxing Day", "Greenery", BOM + "Neon" + BOM]
        for event_type in audit.EVENT_TYPES:
            for theme in themes:
                entry = make_entry(event_type, theme)
                code = audit.code_theme_is_real(entry)
                sentence = csc.render_push_sentence(entry)
                with self.subTest(type=event_type, theme=theme):
                    if event_type == "Regular":
                        self.assertEqual(sentence.startswith("Tonight's theme is REGULAR,"), not code)
                    else:
                        special = CHAMPIONSHIP_LINE if event_type == "Championship" else BIG_STACK_LINE
                        self.assertEqual(sentence == special, not code)


class StatusRuleTests(unittest.TestCase):
    def check(self, entry, state, source, code, status):
        row = audit.audit_entry(entry)
        self.assertEqual(
            (row["theme_state"], row["gear_source"], row["code_theme_is_real"], row["status"]),
            (state, source, code, status),
        )
        return row

    def test_filler_the_code_prints_blocks_on_special_formats(self):
        row = self.check(make_entry("Big Stack", "N/A"), "filler", "generic", True, "blocked")
        self.assertTrue(row["sentence"].startswith("Tonight's theme is N/A,"))
        self.check(make_entry("Championship", "coming soon"), "filler", "generic", True, "blocked")

    def test_echo_the_code_prints_blocks(self):
        row = self.check(make_entry("Championship", "Regular", "gold"), "type_echo", "custom", True, "blocked")
        self.assertTrue(row["sentence"].startswith("Tonight's theme is REGULAR,"))

    def test_filler_with_custom_gear_still_blocks(self):
        self.check(make_entry("Regular", "TBD", "flannel shirts"), "filler", "custom", True, "blocked")

    def test_regular_fallback_blocks_even_with_custom_gear(self):
        row = self.check(make_entry("Regular", "", "flannel shirts"), "empty", "custom", False, "blocked")
        self.assertTrue(row["sentence"].startswith("Tonight's theme is REGULAR,"))

    def test_special_format_suppression_is_read(self):
        self.check(make_entry("Big Stack", "", "neon shirts"), "empty", "suppressed", False, "read")
        self.check(make_entry("Championship", "Western (placeholder)", "hats"), "filler", "suppressed", False, "read")

    def test_real_theme_on_special_format_follows_gear_rules(self):
        self.check(make_entry("Championship", "Gold Rush", "gold accessories"), "real", "custom", True, "read")
        self.check(make_entry("Championship", "Halloween"), "real", "exact_map", True, "read")
        self.check(make_entry("Big Stack", "Hockey Night"), "real", "sport_substring", True, "needs_signoff")
        self.check(make_entry("Big Stack", "Disco"), "real", "generic", True, "needs_signoff")

    def test_exact_map_is_read_and_uses_the_sanitized_theme(self):
        self.check(make_entry("Regular", " cowboys "), "real", "exact_map", True, "read")

    def test_whitespace_only_gear_is_not_custom(self):
        self.check(make_entry("Regular", "Neon Night", "   "), "real", "generic", True, "needs_signoff")

    def test_every_non_read_row_states_a_reason(self):
        for probe_id, *_ in REVIEW_PROBES:
            row = audit.audit_entry(probe_entry(probe_id))
            with self.subTest(probe=probe_id):
                if row["status"] != "read":
                    self.assertTrue(row["reasons"])


# --- amendment item 1: gear text is checked ---------------------------------------

class GearCheckTests(unittest.TestCase):
    CASES = [
        # gear, expected reason fragment or None
        (ZWSP, "blank once invisible"),
        (ZWSP + " " + BOM, "blank once invisible"),
        ("TBD", "filler"),
        ("t.b.d.", "filler"),
        ("-", "filler"),
        ("?", "filler"),
        ("N/A", "filler"),
        ("na", "filler"),
        ("undefined", "filler"),
        ("(placeholder)", "placeholder"),
        ("placeholder hats", "placeholder"),
        ("Place-Holder hats", "placeholder"),
        # Amendment 2 item 1: filler words inside gear, including "none".
        ("TBD gear", "filler word"),
        ("none needed", "filler word"),
        ("None", "filler"),
        ("N/A - anything", "filler word"),
        ("hats, tbc", "filler word"),
        ("costumes to be confirmed", "filler word"),
        # Amendment 2 item 2: batch and template placeholders.
        ("XXX", "batch or template"),
        ("test", "filler"),
        ("Week 3", "batch or template"),
        ("%s", "batch or template"),
        ("your best ${gear}", "batch or template"),
        # Amendment 2 item 3: gear made only of blank letters.
        (HANGUL_FILLER, "blank once invisible"),
        (HANGUL_CHOSEONG_FILLER + HANGUL_JUNGSEONG_FILLER, "blank once invisible"),
        (BRAILLE_BLANK + " " + HALFWIDTH_HANGUL_FILLER, "blank once invisible"),
        # Real gear.
        ("flannel shirts", None),
        ("gold", None),
        ("Nana costumes", None),
        ("nonetheless shirts", None),
        ("$10 boots & " + COWBOY_FACE + " hats", None),
        ("beads/masks/purple-green-gold", None),
        ("gold " + EM_DASH + " anything shiny", None),
        ("theme inspired gear", None),
        ("   ", None),
        ("", None),
    ]

    def test_gear_problems(self):
        for gear, fragment in self.CASES:
            with self.subTest(gear=gear):
                problems = audit.gear_problems(gear)
                if fragment is None:
                    self.assertEqual(problems, [])
                else:
                    self.assertTrue(any(fragment in p for p in problems), problems)

    def test_filler_gear_blocks_a_real_theme(self):
        row = audit.audit_entry(make_entry("Regular", "Neon Night", "TBD"))
        self.assertEqual((row["gear_source"], row["status"]), ("custom", "blocked"))
        self.assertIn("gear check: gear is a filler value", row["reasons"])

    def test_filler_gear_blocks_even_when_a_special_night_drops_it(self):
        row = audit.audit_entry(make_entry("Big Stack", "", "TBD"))
        self.assertEqual((row["gear_source"], row["status"]), ("suppressed", "blocked"))
        self.assertEqual(row["notes"], ["custom gear was entered, but the special-format line drops it"])


# --- amendment item 3: invisible characters ------------------------------------------

class HiddenCharacterTests(TempDirMixin, unittest.TestCase):
    def test_display_escapes_hidden_characters(self):
        cases = [
            ("a" + ZWSP + "b", "a<U+200B>b"),
            (RLO + "DBT", "<U+202E>DBT"),
            (BOM + "x", "<U+FEFF>x"),
            ("x" + NBSP + "y", "x<U+00A0>y"),
            ("x\ty\n", "x<U+0009>y<U+000A>"),
            ("x" + NEL, "x<U+0085>"),
            ("x" + INFO_SEP_4, "x<U+001C>"),
            ("x" + LONE_SURROGATE, "x<U+D800>"),
            (HANGUL_FILLER, "<U+3164>"),
            (HANGUL_CHOSEONG_FILLER + HANGUL_JUNGSEONG_FILLER, "<U+115F><U+1160>"),
            ("a" + HALFWIDTH_HANGUL_FILLER + BRAILLE_BLANK, "a<U+FFA0><U+2800>"),
            ("D" + I_ACUTE + "a de Muertos", "D" + I_ACUTE + "a de Muertos"),
            ("plain text", "plain text"),
        ]
        for text, shown in cases:
            with self.subTest(shown=shown):
                self.assertEqual(audit.display(text), shown)

    def test_report_shows_what_will_be_sent(self):
        code, out, _ = run_main(["--entries", str(self.probe_entries_file(["P50", "P21"]))])
        self.assertEqual(code, 1)
        self.assertIn('gearDescription="<U+200B>"', out)
        self.assertIn('theme="<U+202E>DBT"', out)
        self.assertIn("sentence: Tonight's theme is <U+202E>DBT,", out)
        self.assertNotIn(ZWSP, out)
        self.assertNotIn(RLO, out)

    def test_hidden_character_makes_a_row_at_least_needs_signoff(self):
        row = audit.audit_entry(probe_entry("P21"))
        self.assertEqual(row["status"], "needs_signoff")
        self.assertTrue(any("U+202E" in reason for reason in row["reasons"]))
        for entry in (
            make_entry("Regular", "Flannel\t", "flannel shirts"),
            make_entry("Regular", "Neon" + LONE_SURROGATE, "neon shirts"),
            make_entry("Regular", "Neon Night", "neon" + ZWSP + " shirts"),
            make_entry("Regular", BOM + "Flannel", "flannel shirts"),
        ):
            with self.subTest(entry=audit.display(repr(entry))):
                self.assertEqual(audit.audit_entry(entry)["status"], "needs_signoff")

    def test_blank_letters_are_shown_and_raise_the_status(self):
        row = audit.audit_entry(make_entry("Regular", "Neon" + HANGUL_FILLER + "Night", "neon shirts"))
        self.assertEqual(row["status"], "needs_signoff")
        self.assertTrue(any("U+3164" in reason for reason in row["reasons"]))
        code, out, _ = run_main(["--entries", str(self.write_json(
            "blank.json", [re_review_entry("R23"), re_review_entry("R24")], ensure_ascii=True))])
        self.assertEqual(code, 1)
        self.assertIn('theme="<U+3164>"', out)
        self.assertIn('gearDescription="<U+3164>"', out)
        self.assertNotIn(HANGUL_FILLER, out)

    def test_lone_surrogate_through_the_cli(self):
        path = self.write_json("surrogate.json", [make_entry("Regular", "Neon" + LONE_SURROGATE, "neon shirts")],
                               ensure_ascii=True)
        code, out, _ = run_main(["--entries", str(path)])
        self.assertEqual(code, 1)
        self.assertIn('theme="Neon<U+D800>"', out)


class LookalikeLetterTests(unittest.TestCase):
    def test_latin_mixed_with_cyrillic_needs_signoff(self):
        row = audit.audit_entry(probe_entry("P15"))
        self.assertEqual(row["status"], "needs_signoff")
        self.assertTrue(any("U+0422, U+0412" in reason for reason in row["reasons"]))
        gear_row = audit.audit_entry(make_entry("Regular", "Neon Night", "ne" + CYRILLIC_O + "n shirts"))
        self.assertEqual(gear_row["status"], "needs_signoff")

    def test_single_script_values_are_not_flagged(self):
        for entry in (
            make_entry("Regular", "D" + I_ACUTE + "a de Muertos", "skull face paint"),
            make_entry("Regular", CYRILLIC_ZIMA, "coats"),
        ):
            with self.subTest(entry=audit.display(repr(entry))):
                self.assertEqual(audit.lookalike_letters(entry["theme"]), [])
                self.assertEqual(audit.audit_entry(entry)["status"], "read")


# --- amendment item 4: run-time check against the renderer ------------------------------

def _drift(entry):
    """The review's drift: a renderer that falls back to the type for every row."""
    return ORIGINAL_RENDER(dict(entry, theme=""))


class RendererCheckTests(TempDirMixin, unittest.TestCase):
    def test_drift_blocks_a_row_that_would_read(self):
        with mock.patch.object(csc, "render_push_sentence", side_effect=_drift):
            row = audit.audit_entry(frozen_entry("T1"))
            code, _, _ = run_main(["--entries", str(self.frozen_entries_file(["T1"]))])
        self.assertEqual(row["status"], "blocked")
        self.assertIn(
            "renderer check: the theme does not change the rendered sentence, but code_theme_is_real is true",
            row["reasons"],
        )
        self.assertEqual(code, 1)

    def test_drift_the_other_way_blocks_too(self):
        def never_drops(entry):
            return ORIGINAL_RENDER(dict(entry, type="Regular")) if entry.get("theme") else ORIGINAL_RENDER(entry)

        with mock.patch.object(csc, "render_push_sentence", side_effect=never_drops):
            row = audit.audit_entry(frozen_entry("T4"))
        self.assertEqual(row["status"], "blocked")
        self.assertTrue(any("changes the rendered sentence" in reason for reason in row["reasons"]))

    def test_no_disagreement_on_the_probes(self):
        # P61 and P62 are pinned by test_prototype_gear_is_a_gear_phrase_disagreement.
        entries = [probe_entry(row[0]) for row in REVIEW_PROBES if row[0] not in PROTOTYPE_PROBE_IDS]
        entries += [re_review_entry(row[0]) for row in RE_REVIEW_PROBES]
        for entry in entries:
            with self.subTest(entry=audit.display(repr(entry))):
                sentence = csc.render_push_sentence(entry)
                code = audit.code_theme_is_real(entry)
                self.assertIsNone(audit.renderer_disagreement(entry, code, sentence))
                self.assertIsNone(audit.gear_disagreement(entry, code, audit.classify_gear(entry, code), sentence))

    def test_prototype_gear_is_a_gear_phrase_disagreement(self):
        # The mirror now returns the app's Object.prototype text, which the audit's
        # generic-gear expectation does not name, so the row is blocked.
        for probe_id, gear_text in (("P61", "function Object() { [native code] }"), ("P62", "[object Object]")):
            entry = probe_entry(probe_id)
            with self.subTest(probe=probe_id):
                sentence = csc.render_push_sentence(entry)
                code = audit.code_theme_is_real(entry)
                self.assertIn(f"wear your best {gear_text} and", sentence)
                self.assertIsNone(audit.renderer_disagreement(entry, code, sentence))
                self.assertEqual(audit.classify_gear(entry, code), "generic")
                self.assertEqual(
                    audit.gear_disagreement(entry, code, "generic", sentence),
                    "gear phrase check: classified as generic, but csc.gear_description returns a different phrase",
                )
                self.assertEqual(audit.audit_entry(entry)["status"], "blocked")


# --- Amendment 2 item 4: run-time check against csc.gear_description --------------------

def _no_custom_gear(entry, theme):
    """The re-review's D4 and D5: gear_description ignores custom gear."""
    return ORIGINAL_GEAR(dict(entry, gearDescription=""), theme)


def _no_map_lookup(entry, theme):
    """The re-review's D6: the renderer's gear lookup breaks while csc.GEAR_MAP is intact."""
    return ORIGINAL_GEAR(entry, theme) if csc._trim(entry["gearDescription"]) else f"{theme} and more"


class GearPhraseCheckTests(TempDirMixin, unittest.TestCase):
    def test_gear_drift_blocks_rows_that_would_read(self):
        cases = [("T7", _no_custom_gear, "custom"), ("T1", _no_custom_gear, "custom"), ("T9", _no_map_lookup, "exact_map")]
        for case_id, drift, source in cases:
            with self.subTest(case=case_id):
                with mock.patch.object(csc, "gear_description", side_effect=drift):
                    row = audit.audit_entry(frozen_entry(case_id))
                self.assertEqual(row["status"], "blocked")
                self.assertIn(f"gear phrase check: classified as {source}, but csc.gear_description returns a different phrase",
                              row["reasons"])

    def test_sport_and_generic_phrases_are_checked(self):
        with mock.patch.object(csc, "gear_description", return_value="hockey gear"):
            sport = audit.audit_entry(frozen_entry("T6"))
            generic = audit.audit_entry(frozen_entry("T10"))
        self.assertEqual((sport["status"], generic["status"]), ("blocked", "blocked"))

    def test_phrase_missing_from_the_sentence_blocks(self):
        def drops_gear(entry):
            sentence = ORIGINAL_RENDER(entry)
            if entry["gearDescription"]:
                return sentence.replace(entry["gearDescription"], "something else")
            return sentence

        with mock.patch.object(csc, "render_push_sentence", side_effect=drops_gear):
            row = audit.audit_entry(frozen_entry("T7"))
        self.assertEqual(row["status"], "blocked")
        self.assertIn("gear phrase check: the rendered sentence does not contain the phrase csc.gear_description returns",
                      row["reasons"])

    def test_suppressed_rows_are_not_checked(self):
        with mock.patch.object(csc, "gear_description", return_value="anything"):
            self.assertEqual(audit.audit_entry(frozen_entry("T4"))["status"], "read")


# --- JS-exact mirror: control characters and prototype keys ----------------------------

class JsExactMirrorTests(unittest.TestCase):
    def test_python_only_whitespace_needs_signoff_as_a_hidden_character(self):
        cases = [(probe_entry("P60"), 0x1C, "P60")]
        for event_type in audit.EVENT_TYPES:
            for code_point in (0x1C, 0x1D, 0x1E, 0x1F, 0x85):
                cases.append((make_entry(event_type, "Flannel" + chr(code_point), "flannel shirts"), code_point,
                              f"{event_type} theme"))
                cases.append((make_entry(event_type, "Flannel", "flannel shirts" + chr(code_point)), code_point,
                              f"{event_type} gear"))
        for entry, code_point, field in cases:
            with self.subTest(code_point=f"U+{code_point:04X}", field=field):
                row = audit.audit_entry(entry)
                self.assertEqual(row["status"], "needs_signoff")
                self.assertTrue(any(
                    "invisible or non-printing characters" in reason and f"U+{code_point:04X}" in reason
                    for reason in row["reasons"]
                ))
                self.assertFalse(any("mirror" in reason.lower() for reason in row["reasons"]))

    def test_nel_on_a_special_night_is_printed_and_blocked(self):
        # The JS-exact mirror keeps U+0085, so the theme no longer echoes the type
        # (P58) and the placeholder marker is no longer trailing (P59). The code
        # prints the theme sentence instead of the special line.
        for probe_id, state in (("P58", "type_echo"), ("P59", "filler")):
            entry = probe_entry(probe_id)
            row = audit.audit_entry(entry)
            with self.subTest(probe=probe_id):
                self.assertTrue(audit.code_theme_is_real(entry))
                self.assertTrue(row["sentence"].startswith("Tonight's theme is "))
                self.assertIn(NEL, row["sentence"])
                self.assertEqual(row["status"], "blocked")
                self.assertIn(f"the code prints this theme, which the audit classes as {state}", row["reasons"])

    def test_prototype_keys_with_blank_gear_are_blocked(self):
        phrase_check = "gear phrase check: classified as generic, but csc.gear_description returns a different phrase"
        for event_type, theme, gear in itertools.product(
                audit.EVENT_TYPES, ("Constructor", "CONSTRUCTOR", " __proto__ ", "__PROTO__"), ("", "   ")):
            with self.subTest(event_type=event_type, theme=theme, gear=gear):
                row = audit.audit_entry(make_entry(event_type, theme, gear))
                self.assertEqual(row["status"], "blocked")
                self.assertIn(phrase_check, row["reasons"])
        constructors = audit.audit_entry(make_entry("Regular", "Constructors"))
        self.assertNotEqual(constructors["status"], "blocked")
        self.assertFalse(any(reason.startswith("gear phrase check") for reason in constructors["reasons"]))

    def test_prototype_keys_with_custom_gear_read(self):
        # Custom gear wins before the app's map lookup, so the prototype text is never printed.
        self.assertEqual(audit.audit_entry(make_entry("Regular", "Constructor", "hard hats"))["status"], "read")
        self.assertEqual(audit.audit_entry(make_entry("Regular", "__proto__", "lab coats"))["status"], "read")

    def test_approval_clears_a_hidden_character_row(self):
        p60 = probe_entry("P60")
        row = audit.audit_entry(p60, [("Regular", p60["theme"], csc.render_push_sentence(p60))])
        self.assertEqual((row["status"], row["signoff"]), ("read", "approved"))
        # An approval of a different sentence does not clear it.
        row = audit.audit_entry(p60, [("Regular", p60["theme"], "Tonight's theme is FLANNEL.")])
        self.assertEqual((row["status"], row["signoff"]), ("needs_signoff", "stale"))
        # The control character may sit in the gear instead of the theme.
        in_gear = make_entry("Regular", "Flannel", "flannel shirts" + chr(0x1F))
        row = audit.audit_entry(in_gear, [("Regular", "Flannel", csc.render_push_sentence(in_gear))])
        self.assertEqual((row["status"], row["signoff"]), ("read", "approved"))
        p61 = probe_entry("P61")
        row = audit.audit_entry(p61, [("Regular", "Constructor", csc.render_push_sentence(p61))])
        self.assertEqual((row["status"], row["signoff"]), ("blocked", "ignored"))
        p48 = probe_entry("P48")
        row = audit.audit_entry(p48, [("Regular", "Neon Night", csc.render_push_sentence(p48))])
        self.assertEqual((row["status"], row["signoff"]), ("read", "approved"))

    def test_no_row_claims_a_mirror_difference(self):
        mirror_difference_phrase = "may render it differently"
        for table, entry_factory in ((REVIEW_PROBES, probe_entry), (RE_REVIEW_PROBES, re_review_entry)):
            for probe_id, *_ in table:
                with self.subTest(probe=probe_id):
                    row = audit.audit_entry(entry_factory(probe_id))
                    self.assertFalse(any(mirror_difference_phrase in reason for reason in row["reasons"]))


# --- amendment item 6: small contract items --------------------------------------------

class ContractItemTests(TempDirMixin, unittest.TestCase):
    def test_empty_array_exits_2(self):
        code, out, err = run_main(["--entries", str(self.write_json("empty.json", []))])
        self.assertEqual(code, 2)
        self.assertEqual(out, "")
        self.assertIn("empty", err)

    def test_dropped_custom_gear_is_noted(self):
        note = "custom gear was entered, but the special-format line drops it"
        for probe_id in ("P30", "P57"):
            with self.subTest(probe=probe_id):
                row = audit.audit_entry(probe_entry(probe_id))
                self.assertEqual((row["status"], row["notes"]), ("read", [note]))
        for entry in (frozen_entry("T4"), frozen_entry("T5"), make_entry("Regular", "", "flannel shirts")):
            self.assertEqual(audit.audit_entry(entry)["notes"], [])
        _, out, _ = run_main(["--entries", str(self.probe_entries_file(["P30"]))])
        self.assertIn("    note: " + note, out)

    def test_placeholder_marker_comes_from_the_mirror(self):
        def also_strips_draft(raw):
            text = ORIGINAL_SANITIZE(raw)
            return text[: -len(" (draft)")] if text.endswith(" (draft)") else text

        self.assertTrue(audit.has_placeholder_marker("Western (placeholder)"))
        self.assertFalse(audit.has_placeholder_marker("Western (draft)"))
        with mock.patch.object(csc, "sanitize_theme", side_effect=also_strips_draft):
            self.assertTrue(audit.has_placeholder_marker("Western (draft)"))


# --- signoff --------------------------------------------------------------------

class SignoffTests(TempDirMixin, unittest.TestCase):
    def t10_approval(self, sentence=None, event_type="Regular", theme="Neon Night"):
        return [(event_type, theme, sentence if sentence is not None else frozen_expected("T10")["sentence"])]

    def test_exact_triple_clears_needs_signoff(self):
        row = audit.audit_entry(frozen_entry("T10"), self.t10_approval())
        self.assertEqual((row["status"], row["signoff"]), ("read", "approved"))

    def test_changing_the_approved_sentence_invalidates_signoff(self):
        changed = frozen_expected("T10")["sentence"].replace("inspired gear", "inspired outfits")
        row = audit.audit_entry(frozen_entry("T10"), self.t10_approval(changed))
        self.assertEqual((row["status"], row["signoff"]), ("needs_signoff", "stale"))

    def test_a_new_rendered_sentence_invalidates_signoff(self):
        def longer_phrase(entry, theme):
            return ORIGINAL_GEAR(entry, theme) + " and neon accessories"

        with mock.patch.object(csc, "gear_description", side_effect=longer_phrase):
            row = audit.audit_entry(frozen_entry("T10"), self.t10_approval())
        self.assertEqual((row["status"], row["signoff"]), ("needs_signoff", "stale"))

    def test_changing_type_or_theme_invalidates_signoff(self):
        for approvals in (self.t10_approval(theme="neon night"), self.t10_approval(theme="Neon Night "),
                          self.t10_approval(event_type="Big Stack")):
            with self.subTest(approvals=approvals):
                row = audit.audit_entry(frozen_entry("T10"), approvals)
                self.assertEqual(row["status"], "needs_signoff")

    def test_no_signoff_clears_a_blocked_row_or_makes_filler_real(self):
        for case_id in sorted(BLOCKED_IDS):
            with self.subTest(case=case_id):
                entry = frozen_entry(case_id)
                approvals = [(entry["type"], entry["theme"], frozen_expected(case_id)["sentence"])]
                row = audit.audit_entry(entry, approvals)
                self.assertEqual(row["status"], "blocked")
                self.assertEqual(row["signoff"], "ignored")
                self.assertEqual(row["theme_state"], frozen_expected(case_id)["theme_state"])

    def test_cli_signoff_flow(self):
        entries = self.frozen_entries_file(["T1", "T4", "T5", "T7", "T9", "T10"])
        code, out, _ = run_main(["--entries", str(entries)])
        self.assertEqual(code, 1)
        self.assertIn("needs_signoff: row 6", out)

        approved = self.write_json("approved.json", [
            {"type": "Regular", "theme": "Neon Night", "expected_sentence": frozen_expected("T10")["sentence"]},
        ])
        code, out, _ = run_main(["--entries", str(entries), "--approved-themes", str(approved)])
        self.assertEqual(code, 0)
        self.assertIn("signoff=approved", out)
        self.assertIn("approvals: 1 loaded, 1 applied", out)

        changed = self.write_json("changed.json", [
            {"type": "Regular", "theme": "Neon Night",
             "expected_sentence": frozen_expected("T10")["sentence"].replace("NEON NIGHT", "NEON NITE")},
        ])
        code, out, _ = run_main(["--entries", str(entries), "--approved-themes", str(changed)])
        self.assertEqual(code, 1)
        self.assertIn("signoff=stale", out)

    def test_cli_all_signoffs_still_exit_1_while_rows_are_blocked(self):
        approvals = [{"type": frozen_entry(i)["type"], "theme": frozen_entry(i)["theme"],
                      "expected_sentence": frozen_expected(i)["sentence"]} for i in FROZEN_IDS]
        code, out, _ = run_main(["--entries", str(self.frozen_entries_file()),
                                 "--approved-themes", str(self.write_json("all.json", approvals))])
        self.assertEqual(code, 1)
        self.assertIn("8 read, 0 needs_signoff, 6 blocked", out)
        self.assertIn("blocked: row 2, row 3, row 11, row 12, row 13, row 14", out)


# --- input validation ---------------------------------------------------------------

class InputValidationTests(TempDirMixin, unittest.TestCase):
    def assert_exit_2_without_report(self, argv):
        code, out, err = run_main(argv)
        self.assertEqual(code, 2, err)
        self.assertEqual(out, "")
        return err

    def test_malformed_entries_exit_2(self):
        good = make_entry("Regular", "Flannel", "flannel shirts")
        bad_docs = {
            "object_top": good,
            "string_top": "Regular",
            "null_top": None,
            "empty_array": [],
            "row_array": [["Regular", "Flannel", "", ""]],
            "nested_array": [[good]],
            "row_string": ["Regular"],
            "row_null": [None],
            "missing_field": [{k: v for k, v in good.items() if k != "announcementNote"}],
            "extra_field": [dict(good, date="2026-10-20")],
            "spaced_key": [{(" type" if k == "type" else k): v for k, v in good.items()}],
            "null_theme": [dict(good, theme=None)],
            "number_theme": [dict(good, theme=5)],
            "bool_gear": [dict(good, gearDescription=True)],
            "list_note": [dict(good, announcementNote=[])],
            "lowercase_type": [dict(good, type="regular")],
            "padded_type": [dict(good, type=" Regular")],
            "unknown_type": [dict(good, type="Poker Night")],
            "empty_type": [dict(good, type="")],
            "second_row_bad": [good, dict(good, type="Big stack")],
        }
        for name, doc in bad_docs.items():
            with self.subTest(case=name):
                self.assert_exit_2_without_report(["--entries", str(self.write_json(f"{name}.json", doc))])

    def test_unparseable_entries_exit_2(self):
        raw_docs = {
            "truncated": b'[{"type": "Regular"',
            "not_json": b"Regular, Flannel",
            "empty_file": b"",
            "trailing_comma": b'[{"type": "Regular", "theme": "Flannel", "gearDescription": "x", "announcementNote": ""},]',
            "utf16": '[{"type": "Regular"}]'.encode("utf-16"),
            "bad_utf8": b'[{"type": "Regular", "theme": "\xff", "gearDescription": "", "announcementNote": ""}]',
            "duplicate_key": b'[{"type": "Regular", "theme": "TBD", "theme": "Flannel", '
                             b'"gearDescription": "", "announcementNote": ""}]',
            "nan_theme": b'[{"type": "Regular", "theme": NaN, "gearDescription": "", "announcementNote": ""}]',
        }
        for name, data in raw_docs.items():
            with self.subTest(case=name):
                self.assert_exit_2_without_report(["--entries", str(self.write_bytes(f"{name}.json", data))])

    def test_missing_file_exits_2(self):
        self.assert_exit_2_without_report(["--entries", str(self.tmp / "nope.json")])

    def test_malformed_approvals_exit_2(self):
        entries = str(self.frozen_entries_file(["T10"]))
        sentence = frozen_expected("T10")["sentence"]
        good = {"type": "Regular", "theme": "Neon Night", "expected_sentence": sentence}
        bad_docs = {
            "object_top": good,
            "missing_sentence": [{"type": "Regular", "theme": "Neon Night"}],
            "extra_field": [dict(good, approved_by="J")],
            "number_theme": [dict(good, theme=10)],
            "unknown_type": [dict(good, type="Poker Night")],
        }
        for name, doc in bad_docs.items():
            with self.subTest(case=name):
                self.assert_exit_2_without_report(
                    ["--entries", entries, "--approved-themes", str(self.write_json(f"appr_{name}.json", doc))]
                )

    def test_argument_errors_exit_2(self):
        self.assertEqual(run_main([])[0], 2)
        self.assertEqual(run_main(["--expectations", str(EXPECTATIONS), "--entries", "x.json"])[0], 2)
        self.assertEqual(run_main(["--expectations", str(EXPECTATIONS), "--approved-themes", "x.json"])[0], 2)

    def test_leading_bom_is_accepted(self):
        data = json.dumps([frozen_entry("T1")]).encode("utf-8")
        code, out, _ = run_main(["--entries", str(self.write_bytes("bom.json", b"\xef\xbb\xbf" + data))])
        self.assertEqual(code, 0)
        self.assertIn("status=read", out)


# --- command line ---------------------------------------------------------------------

class CliTests(TempDirMixin, unittest.TestCase):
    def test_expectations_prints_14_of_14_and_exits_0(self):
        code, out, err = run_main(["--expectations", str(EXPECTATIONS)])
        self.assertEqual(code, 0, err)
        self.assertIn("14 of 14 frozen cases match.", out)
        self.assertIn("Ordinary audit of these same 14 cases: exit 1 (frozen exit 1, as frozen)", out)
        self.assertIn("blocked: T2, T3, T11, T12, T13, T14", out)
        self.assertIn("needs_signoff: T6, T8, T10", out)

    def test_ordinary_audit_of_the_frozen_entries_exits_1_and_prints_every_row(self):
        code, out, _ = run_main(["--entries", str(self.frozen_entries_file())])
        self.assertEqual(code, 1)
        self.assertIn("14 rows read, 14 rows reported: 5 read, 3 needs_signoff, 6 blocked.", out)
        self.assertIn("blocked: row 2, row 3, row 11, row 12, row 13, row 14", out)
        self.assertIn("needs_signoff: row 6, row 8, row 10", out)
        for number, case_id in enumerate(FROZEN_IDS, start=1):
            with self.subTest(case=case_id):
                self.assertIn(f"row {number}: status={frozen_expected(case_id)['status']} ", out)
                self.assertIn("sentence: " + frozen_expected(case_id)["sentence"], out)

    def test_tbd_row_shows_code_true_audit_filler(self):
        _, out, _ = run_main(["--entries", str(self.frozen_entries_file(["T2"]))])
        self.assertIn("(code: true, audit: filler)", out)

    def test_all_read_rows_exit_0(self):
        code, _, _ = run_main(["--entries", str(self.frozen_entries_file(sorted(READ_IDS)))])
        self.assertEqual(code, 0)

    def test_script_runs_standalone(self):
        env = dict(os.environ, PYTHONDONTWRITEBYTECODE="1")
        proc = subprocess.run(
            [sys.executable, str(AUDIT_PATH), "--expectations", str(EXPECTATIONS)],
            capture_output=True, text=True, encoding="utf-8", env=env, cwd=str(self.tmp), timeout=120,
        )
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertIn("14 of 14", proc.stdout)

    def test_no_network_is_touched(self):
        with mock.patch("socket.socket", side_effect=AssertionError("network used")):
            self.assertEqual(run_main(["--expectations", str(EXPECTATIONS)])[0], 0)
            self.assertEqual(run_main(["--entries", str(self.frozen_entries_file())])[0], 1)


# --- planted failures in the audit's own rules ------------------------------------------

class PlantedAuditFailureTests(TempDirMixin, unittest.TestCase):
    def test_removing_tbd_from_filler_breaks_t2(self):
        with mock.patch.object(audit, "FILLER_THEMES", audit.FILLER_THEMES - {"tbd"}):
            report = run_frozen()
        self.assertIn("T2", failed_ids(report))
        self.assertEqual(failed_ids(report), {"T2", "T14"})
        self.assertFalse(report["ok"])

    def test_boxing_day_treated_as_safe_breaks_t6(self):
        with mock.patch.object(audit, "SIGNOFF_SOURCES", frozenset({"generic"})):
            report = run_frozen()
        self.assertIn("T6", failed_ids(report))
        self.assertEqual(failed_ids(report), {"T6", "T8"})

    def test_reversed_gear_precedence_breaks_t7(self):
        with mock.patch.object(audit, "GEAR_PRECEDENCE", tuple(reversed(audit.GEAR_PRECEDENCE))):
            report = run_frozen()
        self.assertEqual(failed_ids(report), {"T7"})

    def test_echo_treated_as_costume_breaks_t4(self):
        with mock.patch.object(audit, "is_type_echo", return_value=False):
            report = run_frozen()
        self.assertIn("T4", failed_ids(report))
        self.assertEqual(failed_ids(report), {"T4", "T13"})

    def test_dropped_row_fails_coverage(self):
        def drop_last(entries, approvals=()):
            return ORIGINAL_AUDIT_ENTRIES(entries, approvals)[:-1]

        with mock.patch.object(audit, "audit_entries", side_effect=drop_last):
            report = run_frozen()
            code, out, _ = run_main(["--expectations", str(EXPECTATIONS)])
            # The dropped last row is the only blocked one here, so without the
            # coverage check the ordinary audit would exit 0.
            code_entries, _, err = run_main(["--entries", str(self.frozen_entries_file(["T1", "T9", "T2"]))])
        self.assertEqual(failed_ids(report), {"T14"})
        self.assertEqual(outcome_for(report, "T14")["problems"], ["missing from the audit output"])
        self.assertIsNotNone(report["coverage"])
        self.assertEqual(code, 1)
        self.assertIn("13 of 14 frozen cases match.", out)
        self.assertEqual(code_entries, 1)
        self.assertIn("coverage", err)

    def test_case_missing_from_the_expectations_file_fails_coverage(self):
        data = json.loads(EXPECTATIONS.read_text(encoding="utf-8"))
        data["cases"] = [case for case in data["cases"] if case["id"] != "T7"]
        code, out, _ = run_main(["--expectations", str(self.write_json("dropped.json", data))])
        self.assertEqual(code, 1)
        self.assertIn("T7 MISMATCH: missing from the expectations file", out)
        self.assertIn("13 of 14 frozen cases match.", out)

    def test_always_pass_checker_fails_the_nine_rows(self):
        with mock.patch.object(audit, "decide_status", return_value="read"):
            report = run_frozen()
            ordinary, _, _ = run_main(["--entries", str(self.frozen_entries_file())])
        self.assertEqual(failed_ids(report), BLOCKED_IDS | SIGNOFF_IDS)
        self.assertEqual(len(failed_ids(report)), 9)
        self.assertFalse(report["ok"])
        # The ordinary audit alone would pass everything; only the frozen run catches it.
        self.assertEqual(ordinary, 0)


# --- amendment reverts: each item is load-bearing for named rows ------------------------

class AmendmentRevertTests(unittest.TestCase):
    def assert_breaks(self, must_break):
        broken = probe_mismatches()
        self.assertTrue(set(must_break) <= broken, f"did not break: {sorted(set(must_break) - broken)}")
        return broken

    def test_baseline_has_no_mismatch(self):
        self.assertEqual(probe_mismatches(), set())

    def test_item1_gear_check_reverted(self):
        with mock.patch.object(audit, "gear_problems", return_value=[]):
            self.assert_breaks({"P50", "P51", "P52", "P53", "P54", "R13", "R14", "R15", "R24", "R25", "N16"})
            review_only = probe_mismatches(REVIEW_PROBES)
        self.assertEqual(review_only, {"P50", "P51", "P52", "P53", "P54"})

    def test_item2_normalization_reverted(self):
        with mock.patch.object(audit, "normalize_text", side_effect=lambda text: text):
            self.assert_breaks({"P16"})

    def test_item2_punctuation_removal_reverted(self):
        def key_with_punctuation(text):
            return audit.normalize_text(text).upper().casefold()

        # P02 (tbd.) and P04 (TBD!) are also caught by Amendment 2's filler-word rule.
        with mock.patch.object(audit, "theme_key", side_effect=key_with_punctuation):
            self.assert_breaks({"P03", "P07", "P09", "P10", "P32", "P35"})

    def test_item2_new_filler_words_reverted(self):
        original = frozenset({"tbd", "tba", "n/a", "none", "placeholder", "theme", "coming soon", "-", "--", "tbc", "?"})
        with mock.patch.object(audit, "FILLER_THEMES", original):
            self.assert_breaks({"P11", "P12"})

    def test_item2_placeholder_anywhere_reverted(self):
        def trailing_marker_only(text):
            return audit.has_placeholder_marker(csc._trim(text))

        with mock.patch.object(audit, "contains_placeholder", side_effect=trailing_marker_only):
            self.assert_breaks({"P22", "P23", "P25", "P26", "P27", "P28", "P29"})

    def test_item2_any_type_echo_reverted(self):
        def own_type_only(theme, event_type):
            return audit.theme_key(theme) == audit.theme_key(event_type)

        with mock.patch.object(audit, "is_type_echo", side_effect=own_type_only):
            self.assert_breaks({"P37", "P38", "P39"})

    def test_item3_signoff_on_hidden_characters_reverted(self):
        with mock.patch.object(audit, "hidden_characters", return_value=[]):
            self.assert_breaks({"P21"})

    def test_item3_display_reverted(self):
        row = audit.audit_entry(probe_entry("P50"))
        self.assertTrue(report_shows_hidden(row))
        with mock.patch.object(audit, "display", side_effect=lambda text: text):
            self.assertFalse(report_shows_hidden(row))

    def test_item4_renderer_check_reverted(self):
        with mock.patch.object(csc, "render_push_sentence", side_effect=_drift):
            self.assertEqual(audit.audit_entry(frozen_entry("T1"))["status"], "blocked")
            with mock.patch.object(audit, "renderer_disagreement", return_value=None):
                self.assertEqual(audit.audit_entry(frozen_entry("T1"))["status"], "read")

    def test_lookalike_check_reverted(self):
        with mock.patch.object(audit, "lookalike_letters", return_value=[]):
            self.assert_breaks({"P15"})


class Amendment2RevertTests(unittest.TestCase):
    def assert_breaks(self, must_break):
        broken = probe_mismatches()
        self.assertTrue(set(must_break) <= broken, f"did not break: {sorted(set(must_break) - broken)}")
        return broken

    def test_item1_filler_words_reverted(self):
        with mock.patch.object(audit, "has_filler_word", return_value=False):
            self.assert_breaks({"R01", "R02", "R03", "R04", "R13", "R14", "R15"})

    def test_item2_batch_and_template_placeholders_reverted(self):
        with mock.patch.object(audit, "is_batch_placeholder", return_value=False):
            self.assert_breaks({"R05", "R10", "R11", "R12"})

    def test_item2_new_filler_values_reverted(self):
        amendment_1_set = frozenset({"tbd", "tba", "n/a", "none", "placeholder", "theme", "coming soon",
                                     "-", "--", "tbc", "?", "undefined", "null", "na"})
        with mock.patch.object(audit, "FILLER_THEMES", amendment_1_set):
            self.assert_breaks({"R06", "R07", "R08", "R09"})

    def test_item3_blank_letters_reverted(self):
        with mock.patch.object(audit, "BLANK_LETTERS", frozenset()):
            self.assert_breaks({"R23", "R24", "R25"})
            self.assertEqual(audit.display(HANGUL_FILLER), HANGUL_FILLER)

    def test_item4_gear_phrase_check_reverted(self):
        with mock.patch.object(csc, "gear_description", side_effect=_no_custom_gear):
            self.assertEqual(audit.audit_entry(frozen_entry("T7"))["status"], "blocked")
            with mock.patch.object(audit, "gear_disagreement", return_value=None):
                self.assertEqual(audit.audit_entry(frozen_entry("T7"))["status"], "read")

    def test_item5_emoji_only_reverted(self):
        with mock.patch.object(audit, "is_emoji_only", return_value=False):
            self.assert_breaks({"N09"})

    def test_item5_type_name_plus_suffix_reverted(self):
        with mock.patch.object(audit, "is_type_with_suffix", return_value=False):
            self.assert_breaks({"R16", "R17", "R18", "P33", "P36", "P40"})


# --- planted failures in the mirror, patched on the csc module -------------------------

class MirrorPatchTests(unittest.TestCase):
    def assert_exposed(self, report, must_break):
        """Call inside the patch: every case whose rendered sentence changed shows it."""
        failed = failed_ids(report)
        for case_id in must_break:
            self.assertIn(case_id, failed)
        for case_id in FROZEN_IDS:
            patched = csc.render_push_sentence(frozen_entry(case_id))
            if patched != frozen_expected(case_id)["sentence"]:
                with self.subTest(case=case_id):
                    self.assertEqual(outcome_for(report, case_id)["result"]["sentence"], patched)
                    self.assertIn(case_id, failed)
        return failed

    def test_sanitize_theme_patch_breaks_t1(self):
        with mock.patch.object(csc, "sanitize_theme", return_value=""):
            report = run_frozen()
            failed = self.assert_exposed(report, {"T1"})
        t1 = outcome_for(report, "T1")["result"]
        self.assertEqual(t1["status"], "blocked")
        self.assertEqual(
            t1["sentence"],
            "Tonight's theme is REGULAR, so wear your best flannel shirts and show up by 6:50 to receive your bonus.",
        )
        self.assertEqual(failed, ALL_IDS - {"T4", "T5", "T11", "T12", "T13"})

    def test_gear_description_patch_breaks_t1_and_t6(self):
        with mock.patch.object(csc, "gear_description", return_value="MUTATED GEAR"):
            report = run_frozen()
            failed = self.assert_exposed(report, {"T1", "T6"})
        self.assertEqual(failed, ALL_IDS - {"T4", "T5"})
        self.assertIn("wear your best MUTATED GEAR and", outcome_for(report, "T6")["result"]["sentence"])

    def test_gear_description_ignoring_custom_gear_breaks_t1(self):
        def no_custom(entry, theme):
            return ORIGINAL_GEAR(dict(entry, gearDescription=""), theme)

        with mock.patch.object(csc, "gear_description", side_effect=no_custom):
            report = run_frozen()
            failed = self.assert_exposed(report, {"T1"})
        self.assertEqual(failed, {"T1", "T7"})

    def test_gear_patch_reaches_the_renderers_own_call(self):
        t6 = frozen_entry("T6")
        with mock.patch.object(csc, "gear_description", wraps=ORIGINAL_GEAR) as spy:
            row = audit.audit_entry(t6)
        # Two calls come from the renderer (the row and the theme-blank renderer
        # check) and one from the audit's own gear phrase check.
        self.assertEqual(spy.call_count, 3)
        self.assertEqual(spy.call_args_list.count(mock.call(t6, "Boxing Day")), 2)
        self.assertIn(mock.call(dict(t6, theme=""), "Regular"), spy.call_args_list)
        self.assertEqual(row["sentence"], frozen_expected("T6")["sentence"])

        # The audit never builds the sentence, so a marker in it came from the
        # renderer's own call to csc.gear_description.
        with mock.patch.object(csc, "gear_description", return_value="SPY GEAR") as spy:
            row = audit.audit_entry(t6)
        self.assertIn("wear your best SPY GEAR and", row["sentence"])
        self.assertEqual(spy.call_count, 3)

        # With the renderer stubbed, only the audit's own gear phrase check calls
        # gear_description, so the other two calls above came from the renderer.
        with mock.patch.object(csc, "gear_description", return_value="SPY GEAR") as spy, \
                mock.patch.object(csc, "render_push_sentence", return_value="stub sentence"):
            row = audit.audit_entry(t6)
        self.assertEqual(spy.call_count, 1)
        self.assertEqual(row["sentence"], "stub sentence")

    def test_render_always_suppressing_special_formats_breaks_t14(self):
        def always_suppress(entry):
            if entry.get("type") in ("Big Stack", "Championship"):
                return ORIGINAL_RENDER(dict(entry, theme=""))
            return ORIGINAL_RENDER(entry)

        with mock.patch.object(csc, "render_push_sentence", side_effect=always_suppress):
            report = run_frozen()
            failed = self.assert_exposed(report, {"T14"})
        self.assertEqual(failed, {"T14"})
        self.assertEqual(outcome_for(report, "T14")["result"]["sentence"], CHAMPIONSHIP_LINE)

    def test_render_treating_special_formats_as_regular_breaks_t4(self):
        def as_regular(entry):
            return ORIGINAL_RENDER(dict(entry, type="Regular"))

        with mock.patch.object(csc, "render_push_sentence", side_effect=as_regular):
            report = run_frozen()
            failed = self.assert_exposed(report, {"T4"})
        self.assertEqual(failed, {"T4", "T5"})

    def test_gear_map_is_read_at_call_time(self):
        with mock.patch.object(csc, "GEAR_MAP", {}):
            report = run_frozen()
            failed = self.assert_exposed(report, {"T9"})
        self.assertEqual(failed, {"T9"})
        self.assertEqual(outcome_for(report, "T9")["result"]["gear_source"], "generic")

    def test_sport_words_are_read_at_call_time(self):
        with mock.patch.object(csc, "SPORT_WORDS", []):
            report = run_frozen()
            failed = self.assert_exposed(report, {"T6"})
        self.assertEqual(failed, {"T6", "T8"})
        self.assertEqual(outcome_for(report, "T6")["result"]["gear_source"], "generic")

    def test_trim_is_read_at_call_time(self):
        with mock.patch.object(csc, "render_push_sentence", return_value="stub sentence"), \
                mock.patch.object(csc, "_trim", wraps=ORIGINAL_TRIM) as spy:
            audit.audit_entry(frozen_entry("T1"))
        self.assertTrue(spy.called)


if __name__ == "__main__":
    unittest.main()

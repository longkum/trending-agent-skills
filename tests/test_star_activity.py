"""Regression tests for official (not net) GitHub historical Star growth."""
import importlib.util
from datetime import datetime, timedelta, timezone
from pathlib import Path
import unittest

SRC = Path(__file__).resolve().parents[1] / "scripts/collect_star_activity.py"
SPEC = importlib.util.spec_from_file_location("star_activity", SRC)
code = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(code)
NOW = datetime(2026, 10, 31, 15, 0, tzinfo=timezone.utc)


def weekly(today=NOW.date(), value=2, count=6):
    week_start = today - timedelta(days=(today.weekday() + 1) % 7)
    return [{"week": int(datetime.combine(week_start-timedelta(days=7*i),
                     datetime.min.time(), timezone.utc).timestamp()),
             "total": value*7, "days": [value]*7} for i in range(count)]


class StarActivityTests(unittest.TestCase):
    def test_all_windows_use_completed_days_not_partial_today(self):
        sample = weekly()
        rows = code.normalize_buckets(sample, NOW, "2025-01-01")
        self.assertEqual(len(rows), 30)
        self.assertEqual(rows[-1], ["2026-10-30", 2])
        self.assertEqual(rows[0][0], "2026-10-01")
        metrics = code.make_windows(rows, 100)
        self.assertEqual(metrics["1"]["delta"], 2)
        self.assertEqual(metrics["7"]["delta"], 14)
        self.assertEqual(metrics["30"]["delta"], 60)
        self.assertAlmostEqual(metrics["7"]["rate"], 100*14/86, delta=.001)

    def test_missing_day_is_not_zero_and_week_must_sum(self):
        self.assertIsNone(code.normalize_buckets(weekly(count=2), NOW, "2020-01-01"))
        wrong = weekly()
        wrong[0]["total"] += 3
        with self.assertRaises(code.HistoryError):
            code.normalize_buckets(wrong, NOW, "2020-01-01")

    def test_new_repositories_have_real_zero_before_creation(self):
        rows = code.normalize_buckets(weekly(count=2), NOW, "2026-10-27")
        self.assertEqual(rows[0], ["2026-10-01", 0])
        self.assertEqual(rows[-1][1], 2)

    def test_zero_rate_baseline_and_inconsistent_totals(self):
        daily = [["2026-10-%02d" % i, 0] for i in range(1,31)]
        daily[-1][1] = 3
        self.assertIsNone(code.make_windows(daily, 3)["1"]["rate"])
        self.assertFalse(code.make_windows(daily, 3)["1"]["rate_rankable"])
        self.assertIsNone(code.make_windows(daily, 2)["1"]["baseline"])
        self.assertIsNone(code.make_windows(daily, 2)["1"]["rate"])

    def test_progress_rotates_unsampled_before_refetch(self):
        catalog = {
            "org/a": {"stars": 10, "gain_7d": 20, "created_at":"2025-01-01"},
            "org/b": {"stars": 50, "gain_7d": 10, "created_at":"2025-01-01"},
            "org/c": {"stars": 70, "gain_7d": 0, "created_at":"2025-01-01"},
        }
        old = {"schema": 1, "records": {}}
        seen = []
        def fake_fetch(name,token):
            seen.append(name)
            return weekly()
        data, info = code.collect(catalog,old,{},"fake",NOW,2,1,fake_fetch)
        self.assertEqual(info["succeeded"], 2)
        self.assertEqual(seen, ["org/a","org/b"])
        self.assertEqual(data["coverage"], {"total":3,"sampled":2,"fresh":2})
        seen.clear()
        data2, info2 = code.collect(catalog,data,{},"fake",NOW,1,1,fake_fetch)
        self.assertEqual(seen,["org/c"])
        self.assertEqual(data2["coverage"]["sampled"],3)

    def test_failed_repo_preserves_previous_cache_and_never_invents_count(self):
        catalog={"org/a":{"stars":12,"gain_7d":3,"created_at":"2025-01-01"},
                 "org/b":{"stars":50,"gain_7d":1,"created_at":"2025-01-01"}}
        old={"schema":1,"records":{"org/b":{"collected_at":"2026-10-25T00:00:00Z","stars":50}}}
        def fake_fetch(name,token):
            if name=="org/b":raise code.HistoryError("not found")
            return weekly()
        data,info=code.collect(catalog,old,{},"fake",NOW,2,1,fake_fetch)
        self.assertEqual(info["succeeded"],1)
        self.assertEqual(len(info["failures"]),1)
        self.assertEqual(data["records"]["org/b"]["stars"],50)

    def test_name_and_week_validation(self):
        with self.assertRaises(code.HistoryError):
            code.normalize_buckets([{"week":1754784000,"days":[1]*7,"total":8}],NOW,"2020-01-01")
        with self.assertRaises(code.HistoryError):
            code.normalize_buckets([{"week":1754784000,"days":[True]*7,"total":7}],NOW,"2020-01-01")
        with self.assertRaises(code.HistoryError):
            code.fetch_history("org/../a", "fake", lambda *a,**kw: None)


if __name__ == '__main__':unittest.main()
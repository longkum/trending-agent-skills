"""Star-history and collector unit tests, no network calls."""
from __future__ import annotations

from datetime import datetime, timezone
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]


def load(name):
    spec = importlib.util.spec_from_file_location(name, ROOT / 'scripts' / (name + '.py'))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


metrics = load('growth_metrics')
collector = load('collect_stars')
installer = load('enable_growth')


def snapshot(day, entries, aliases=None, hour='06:17:00'):
    return {'day': day, 'at': metrics.utc(day + 'T' + hour + 'Z'),
            'repos': entries, 'aliases': aliases or {}}


class GrowthTests(unittest.TestCase):
    def test_no_snapshots_never_fake_growth(self):
        result = metrics.compile_metrics({'org/a': {}}, [])
        self.assertIsNone(result['as_of'])
        self.assertEqual(result['records'], {})

    def test_complete_1_day_7_day_30_day_metrics(self):
        catalog = {'org/a': {}}
        samples = [
            snapshot('2026-09-01', {'123': {'name':'org/a','stars':10}}),
            snapshot('2026-09-24', {'123': {'name':'org/a','stars':12}}),
            snapshot('2026-09-30', {'123': {'name':'org/a','stars':30}}),
            snapshot('2026-10-01', {'123': {'name':'org/a','stars':40}}),
        ]
        result = metrics.compile_metrics(catalog, samples)['records']['org/a']
        self.assertEqual([result['windows'][str(d)]['delta'] for d in (1,7,30)], [10, 28, 30])
        self.assertEqual(result['windows']['1']['rate'], round(100*10/30, 4))
        self.assertEqual(result['windows']['7']['rate'], round(100*28/12, 4))
        self.assertTrue(result['windows']['30']['rate_rankable'])

    def test_incomplete_windows_zero_baseline_negative_net_and_time_drift(self):
        samples = [
            snapshot('2026-10-01', {'111': {'name':'org/x','stars':0}}),
            snapshot('2026-10-02', {'111': {'name':'org/x','stars':5}}),
        ]
        record = metrics.compile_metrics({'org/x':{}},samples)['records']['org/x']
        self.assertEqual(record['windows']['1']['delta'],5)
        self.assertIsNone(record['windows']['1']['rate'])
        self.assertFalse(record['windows']['1']['rate_rankable'])
        self.assertIsNone(record['windows']['7'])
        modified = [samples[0], snapshot('2026-10-02', {'111': {'name':'org/x','stars':3}}, hour='15:00:00')]
        self.assertIsNone(metrics.compile_metrics({'org/x': {}},modified)['records']['org/x']['windows']['1'])
        neg = [snapshot('2026-10-01', {'111': {'name':'org/x','stars':10}}),
               snapshot('2026-10-02', {'111': {'name':'org/x','stars':8}})]
        self.assertEqual(metrics.compile_metrics({'org/x':{}},neg)['records']['org/x']['windows']['1']['delta'],-2)

    def test_stable_id_across_rename_and_missing_latest_are_not_zero(self):
        samples = [
            snapshot('2026-10-01', {'123':{'name':'org/old','stars':50}}, {'org/old':'123'}),
            snapshot('2026-10-02', {'123':{'name':'new/new','stars':60}}, {'org/old':'123'}),
        ]
        out = metrics.compile_metrics({'org/old':{}},samples)['records']['org/old']
        self.assertEqual(out['name'],'new/new')
        self.assertEqual(out['id'],'123')
        self.assertEqual(out['windows']['1']['delta'],10)
        missing = [samples[0], snapshot('2026-10-02', {}, {})]
        self.assertEqual(metrics.compile_metrics({'org/old':{}},missing)['records'], {})

    def test_validation_rejects_corrupt_snapshot_and_dates(self):
        with tempfile.TemporaryDirectory() as tmp:
            folder = Path(tmp)
            f = folder / '2026-10-01.json'
            invalid = {'schema':1,'collected_at':'2026-10-02T06:17:00Z','repositories':{},'aliases':{}}
            f.write_text(json.dumps(invalid))
            with self.assertRaises(metrics.GrowthDataError): metrics.read_snapshots(folder)
            invalid['collected_at']='2026-10-01T06:17:00Z'
            invalid['repositories']={'123': {'name':'org/x','stars':True}}
            f.write_text(json.dumps(invalid))
            with self.assertRaises(metrics.GrowthDataError): metrics.read_snapshots(folder)

    def test_collector_deduplicates_id_across_names_and_skips_missing(self):
        def fetch(names, token):
            self.assertEqual(token, 'test-token')
            return {'data': {f'r{i}': ({'databaseId': 10,'nameWithOwner':'new/r','stargazerCount':42,'isArchived':False}
                                   if name != 'org/missing' else None) for i,name in enumerate(names)}}
        catalog = {'org/old':{}, 'new/r':{}, 'org/missing':{}}
        data = collector.collect(catalog,'test-token',fetch,now=datetime(2026,10,31,6,17,tzinfo=timezone.utc))
        self.assertEqual(len(data['repositories']),1)
        self.assertEqual(data['repositories']['10']['stars'],42)
        self.assertEqual(len(data['missing']),1)
        self.assertEqual(data['aliases']['org/old'],'10')

    def test_collector_fails_empty_and_invalid_names_without_network(self):
        with self.assertRaises(collector.CollectionError): collector.collect({'org/a':{}},'')
        with self.assertRaises(collector.CollectionError): collector.collect({'org/..':{}},'token')
        with self.assertRaises(collector.CollectionError): collector.collect({'org/a':{}},'token',lambda *_: {'data':{'r0':None}})

    def test_installer_is_idempotent_and_refuses_unknown_template(self):
        with tempfile.TemporaryDirectory() as tmp:
            folder=Path(tmp)
            (folder/'scripts').mkdir(); (folder/'src').mkdir()
            (folder/'src'/'growth-section.html').write_text('GROWTH_SECTION')
            build='x\n    source = root / "src"\nfor filename in ("radix.css", "styles.css")\nfor filename in ("catalog-core.js", "app.js")\n'
            template='      <div class="nav-links">\n        <a href="x">X</a>\n      </div>\n      <section class="catalog" id="catalog" foo="bar">'
            (folder/'scripts'/'build.py').write_text(build)
            (folder/'src'/'index.template.html').write_text(template)
            installer.integrate(folder)
            once=(folder/'scripts'/'build.py').read_text()
            installer.integrate(folder)
            self.assertEqual((folder/'scripts'/'build.py').read_text(),once)
            self.assertIn('growth.css',once)
            self.assertIn('GROWTH_SECTION',(folder/'src'/'index.template.html').read_text())
            (folder/'src'/'index.template.html').write_text('unrelated template',encoding='utf-8')
            with self.assertRaises(RuntimeError): installer.integrate(folder)


if __name__ == '__main__':
    unittest.main()

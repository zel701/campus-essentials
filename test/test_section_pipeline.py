import contextlib
import io
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from scripts import sync_sections as p
from scripts import extract_sections as s


def config(path):
    return {**p.load_config(p.DEFAULT_CONFIG), 'outputDir': str(path), 'retryDelaySeconds': 1,
            'databaseImport': {'enabled': False}}


class Runner:
    """Pipeline tests use deterministic synthetic snapshots, never live HTTP."""
    def __init__(self, failure=None, shrink=False, mismatch=False):
        self.calls = []
        self.failure, self.shrink, self.mismatch = failure, shrink, mismatch

    def __call__(self, args):
        self.calls.append(args)
        options = dict(zip(args[::2], args[1::2]))
        target = Path(options['--output'])
        report_path = target.with_suffix('.report.json')
        if self.failure and len(self.calls) == 1:
            s.atomic_json(report_path, {'complete': False, 'failures': [{'code': self.failure, 'message': self.failure}]})
            return 1
        scope = {'institution': 'SLCMP', 'termId': options['--term'], 'campus': options['--campus'],
                 'subject': options['--subject'], 'courseNumber': options.get('--course'), 'includeClosed': True}
        count = 1 if self.shrink or '--course' in options else 3
        records = [{'id': str(i), 'materialsLinkStatus': 'available', 'source': {'retrievedAt': s.now()}} for i in range(count)]
        if self.mismatch and 'verify-replay' in target.name:
            records[0]['materialsLinkStatus'] = 'not_listed'
        prior = p.read_json(target) if target.exists() else None
        delta = s.reconcile(records, prior)
        digest = s.content_hash(records)
        s.atomic_json(target, {'complete': True, 'scope': scope, 'mode': 'replay' if '--replay' in options else 'live',
                              'sectionCount': count, 'courseCount': 1, 'sections': records, 'contentSha256': digest})
        s.atomic_json(report_path, {'complete': True, 'capturePath': '/tmp/synthetic-capture.json',
                                   'changes': {k: len(v) for k, v in delta.items()}, 'failures': []})
        return 0


class PipelineTests(unittest.TestCase):
    def run_pipeline(self, directory, runner, **kwargs):
        with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
            return p.run_pipeline(config(directory), execute=runner, sleep=lambda _: None, **kwargs)

    def test_full_workflow_has_automatic_preflight_replay_gate_and_publication(self):
        with tempfile.TemporaryDirectory() as tmp:
            runner = Runner()
            self.assertEqual(self.run_pipeline(tmp, runner), 0)
            report = p.read_json(Path(tmp) / 'pipeline.report.json')
            self.assertEqual([a['stage'] for a in report['jobs'][0]['attempts']], ['preflight', 'extract', 'verify-replay'])
            self.assertTrue(report['jobs'][0]['published'])
            self.assertEqual(report['jobs'][0]['summary']['sections'], 3)
            self.assertIn('--course', runner.calls[0])
            self.assertNotIn('--course', runner.calls[1])
            self.assertIn('--replay', runner.calls[2])

    def test_rerun_keeps_ids_and_tracks_unchanged_without_duplicates(self):
        with tempfile.TemporaryDirectory() as tmp:
            self.run_pipeline(tmp, Runner())
            before = p.read_json(Path(tmp) / '2268-MAIN-BIO.json')
            self.run_pipeline(tmp, Runner())
            after = p.read_json(Path(tmp) / '2268-MAIN-BIO.json')
            report = p.read_json(Path(tmp) / 'pipeline.report.json')
            self.assertEqual(before['contentSha256'], after['contentSha256'])
            self.assertEqual(report['jobs'][0]['changes']['unchanged'], 3)
            self.assertEqual(len(list(Path(tmp).glob('.runs/pipeline/*/BIO/previous.json'))), 1)

    def test_only_connection_failure_retries_with_fresh_extraction_invocation(self):
        with tempfile.TemporaryDirectory() as tmp:
            runner = Runner(failure='connection_failed')
            self.assertEqual(self.run_pipeline(tmp, runner), 0)
            self.assertEqual(len(runner.calls), 4)
            first = dict(zip(runner.calls[0][::2], runner.calls[0][1::2]))
            retry = dict(zip(runner.calls[1][::2], runner.calls[1][1::2]))
            self.assertNotEqual(first['--output'], retry['--output'])
        for failure in ['access_blocked', 'rate_limited', 'structure_changed']:
            with self.subTest(failure=failure), tempfile.TemporaryDirectory() as tmp:
                runner = Runner(failure=failure)
                self.assertEqual(self.run_pipeline(tmp, runner), 1)
                self.assertEqual(len(runner.calls), 1)

    def test_quality_failures_preserve_published_snapshot(self):
        for runner in [Runner(shrink=True), Runner(mismatch=True), Runner(failure='access_blocked')]:
            with self.subTest(runner=runner), tempfile.TemporaryDirectory() as tmp:
                self.run_pipeline(tmp, Runner())
                path = Path(tmp) / '2268-MAIN-BIO.json'
                before = path.read_bytes()
                self.assertEqual(self.run_pipeline(tmp, runner), 1)
                self.assertEqual(before, path.read_bytes())
                report = p.read_json(Path(tmp) / 'pipeline.report.json')
                self.assertFalse(report['jobs'][0]['published'])
                self.assertTrue(report['failures'])

    def test_overlapping_run_cannot_overwrite_owner_report(self):
        with tempfile.TemporaryDirectory() as tmp:
            with p.output_lock(Path(tmp)):
                with self.assertRaises(BlockingIOError):
                    self.run_pipeline(tmp, Runner())
                self.assertFalse((Path(tmp) / 'pipeline.report.json').exists())
            self.assertEqual(self.run_pipeline(tmp, Runner()), 0)

    def test_replay_cannot_replace_live_snapshot(self):
        with tempfile.TemporaryDirectory() as tmp:
            self.run_pipeline(tmp, Runner())
            before = (Path(tmp) / '2268-MAIN-BIO.json').read_bytes()
            runner = Runner()
            self.assertEqual(self.run_pipeline(tmp, runner, replay_captures={'BIO': {'pilot': 'p', 'subject': 's'}}), 1)
            self.assertEqual(len(runner.calls), 0)
            self.assertEqual((Path(tmp) / '2268-MAIN-BIO.json').read_bytes(), before)

    def test_status_detects_failure_staleness_config_changes_and_offline_mode(self):
        with tempfile.TemporaryDirectory() as tmp:
            conf = config(tmp)
            cfg = Path(tmp) / 'config.json'
            s.atomic_json(cfg, conf)
            self.run_pipeline(tmp, Runner())
            path = Path(tmp) / 'pipeline.report.json'
            good = p.read_json(path)
            with contextlib.redirect_stdout(io.StringIO()):
                self.assertEqual(p.main(['--config', str(cfg), '--status']), 0)
                for key, value in [('finishedAt', '2020-01-01T00:00:00Z'), ('mode', 'replay'), ('status', 'failed'), ('config', {})]:
                    s.atomic_json(path, {**good, key: value})
                    self.assertEqual(p.main(['--config', str(cfg), '--status']), 1)

    def test_plan_validates_config_without_network_or_output(self):
        with tempfile.TemporaryDirectory() as tmp:
            conf = config(Path(tmp) / 'out')
            cfg = Path(tmp) / 'config.json'
            s.atomic_json(cfg, conf)
            with patch.object(p, 'run_pipeline', side_effect=AssertionError('plan started work')), contextlib.redirect_stdout(io.StringIO()):
                self.assertEqual(p.main(['--config', str(cfg), '--plan']), 0)
            self.assertFalse((Path(tmp) / 'out').exists())
            for key, value in [('term', 'bad'), ('maxRemovalFraction', -1), ('connectionRetries', True), ('jobs', conf['jobs'] * 2)]:
                s.atomic_json(cfg, {**conf, key: value})
                with self.assertRaises(ValueError):
                    p.load_config(cfg)

    def test_multi_subject_failure_is_visible_while_other_subject_can_finish(self):
        with tempfile.TemporaryDirectory() as tmp:
            conf = config(tmp)
            conf['jobs'].append({'subject': 'CHEM', 'pilotCourse': '1111', 'minimumSections': 1})
            with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
                result = p.run_pipeline(conf, execute=Runner(failure='access_blocked'))
            self.assertEqual(result, 1)
            report = p.read_json(Path(tmp) / 'pipeline.report.json')
            self.assertEqual([j['status'] for j in report['jobs']], ['failed', 'complete'])
            self.assertFalse((Path(tmp) / '2268-MAIN-BIO.json').exists())
            self.assertTrue((Path(tmp) / '2268-MAIN-CHEM.json').exists())

    def test_interrupt_stops_before_next_subject(self):
        with tempfile.TemporaryDirectory() as tmp:
            conf = config(tmp)
            conf['jobs'].append({'subject': 'CHEM', 'pilotCourse': '1111', 'minimumSections': 1})
            runner = Runner(failure='interrupted')
            with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
                self.assertEqual(p.run_pipeline(conf, execute=runner), 1)
            report = p.read_json(Path(tmp) / 'pipeline.report.json')
            self.assertEqual(len(runner.calls), 1)
            self.assertEqual(len(report['jobs']), 1)
            self.assertEqual(report['status'], 'failed')

    def test_database_import_runs_after_publication_and_failure_is_retryable(self):
        for failure in [False, True]:
            with self.subTest(failure=failure), tempfile.TemporaryDirectory() as tmp:
                conf = config(tmp)
                conf['databaseImport'] = p.load_config(p.DEFAULT_CONFIG)['databaseImport']
                def importer(snapshot, settings, report_path):
                    self.assertTrue(snapshot.exists())
                    self.assertEqual(settings['tableName'], 'campus-essentials-local')
                    if failure:
                        raise ValueError('Database unavailable; retry import')
                    return {'complete': True, 'created': 3}
                with patch.object(p, 'import_database', side_effect=importer) as call, contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
                    self.assertEqual(p.run_pipeline(conf, execute=Runner()), 1 if failure else 0)
                self.assertEqual(call.call_count, 1)
                report = p.read_json(Path(tmp) / 'pipeline.report.json')
                self.assertTrue(report['jobs'][0]['published'])
                if failure:
                    self.assertEqual(report['failures'][0]['stage'], 'database-import')

    def test_offline_pipeline_never_calls_database_importer(self):
        with tempfile.TemporaryDirectory() as tmp:
            conf = config(tmp)
            conf['databaseImport'] = p.load_config(p.DEFAULT_CONFIG)['databaseImport']
            with patch.object(p, 'import_database', side_effect=AssertionError('offline database write')), contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
                self.assertEqual(p.run_pipeline(conf, replay_captures={'BIO': {'pilot': 'p', 'subject': 's'}}, execute=Runner()), 0)
            report = p.read_json(Path(tmp) / 'pipeline.report.json')
            self.assertEqual(report['jobs'][0]['databaseImport'], {'skipped': 'offline-replay'})


if __name__ == '__main__':
    unittest.main()

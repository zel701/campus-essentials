import contextlib
import io
from pathlib import Path
import tempfile
import unittest

from scripts import expand_sections as x


class ExpansionTests(unittest.TestCase):
    def config(self, root):
        return {**x.p.load_config(x.p.DEFAULT_CONFIG), 'outputDir': str(root), 'connectionRetries': 0}

    def test_queue_only_maps_matching_campus_and_records_gaps(self):
        catalog = {'catalogEdition': '2026-2028', 'courses': [
            {'subject': 'BIO', 'campus': 'San Luis Obispo'},
            {'subject': 'CLA', 'campus': 'San Luis Obispo'},
            {'subject': 'NAU', 'campus': 'Solano'}]}
        subjects = [{'subject': s, 'label': s} for s in ['BIO', 'NAU', 'OLD']]
        state = x.new_queue(self.config('/tmp'), catalog, subjects)
        self.assertEqual([j['subject'] for j in state['jobs']], ['BIO'])
        self.assertEqual(state['catalogSubjectsNotInSearch'], ['CLA'])
        self.assertEqual([s['subject'] for s in state['unmappedSubjects']], ['NAU', 'OLD'])

    def test_resume_skips_finished_and_failed_jobs_until_explicit_retry(self):
        state = {'jobs': [{'subject': s, 'status': t} for s, t in
                         [('BIO', 'complete'), ('CSC', 'failed'), ('ANT', 'running'), ('ASTR', 'pending')]]}
        self.assertEqual([j['subject'] for j in x.select_jobs(state, 1)], ['ANT'])
        self.assertEqual([j['subject'] for j in x.select_jobs(state, 3, retry_failed=True)], ['CSC'])
        self.assertEqual([j['subject'] for j in x.select_jobs(state, 3, ['BIO'], refresh=True)], ['BIO'])
        with self.assertRaises(ValueError):
            x.select_jobs(state, 1, ['UNKNOWN'])

    def test_result_limit_is_recorded_and_next_subject_continues(self):
        with tempfile.TemporaryDirectory() as tmp:
            state = {'jobs': [{'subject': s, 'status': 'pending'} for s in ['CSC', 'ASTR']]}
            def probe(config, subject, directory):
                if subject == 'CSC':
                    raise x.e.ExtractionError('result_limit', '300 sections')
                return {'sectionsDiscovered': 0, 'pilotCourse': None}
            with contextlib.redirect_stdout(io.StringIO()):
                code = x.run(self.config(tmp), state, state['jobs'], Path(tmp) / 'queue.json', probe_fn=probe)
            self.assertEqual(code, 1)
            self.assertEqual([j['status'] for j in state['jobs']], ['failed', 'no_sections'])
            saved = x.p.read_json(Path(tmp) / 'queue.json')
            self.assertEqual(saved['jobs'][0]['error']['code'], 'result_limit')

    def test_access_block_stops_batch_without_querying_other_subjects(self):
        with tempfile.TemporaryDirectory() as tmp:
            state = {'jobs': [{'subject': s, 'status': 'pending'} for s in ['CSC', 'ASTR']]}
            def probe(*args):
                raise x.e.ExtractionError('access_blocked', 'access blocked')
            with contextlib.redirect_stdout(io.StringIO()):
                x.run(self.config(tmp), state, state['jobs'], Path(tmp) / 'queue.json', probe_fn=probe)
            self.assertEqual(state['jobs'][1]['status'], 'pending')

    def test_discovered_pilot_uses_existing_pipeline_and_records_import_failure(self):
        for fail in [False, True]:
            with self.subTest(fail=fail), tempfile.TemporaryDirectory() as tmp:
                state = {'jobs': [{'subject': 'ASTR', 'status': 'pending'}]}
                def pipeline(config):
                    self.assertEqual(config['jobs'], [{'subject': 'ASTR', 'pilotCourse': '1101', 'minimumSections': 1}])
                    x.e.atomic_json(Path(tmp) / 'pipeline.report.json', {
                        'runId': 'test', 'status': 'failed' if fail else 'complete',
                        'failures': [{'message': 'Database unavailable'}] if fail else [],
                        'jobs': [{'summary': {'sections': 12}, 'databaseImport': {'created': 12}}]})
                    return int(fail)
                with contextlib.redirect_stdout(io.StringIO()):
                    code = x.run(self.config(tmp), state, state['jobs'], Path(tmp) / 'queue.json',
                        probe_fn=lambda *a: {'sectionsDiscovered': 12, 'pilotCourse': '1101'}, pipeline_fn=pipeline)
                self.assertEqual(code, int(fail))
                self.assertEqual(state['jobs'][0]['status'], 'failed' if fail else 'complete')
                self.assertIn('pipelineReport', state['jobs'][0])


if __name__ == '__main__':
    unittest.main()

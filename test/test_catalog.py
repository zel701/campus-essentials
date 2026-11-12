import contextlib
import copy
import io
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch
from urllib.error import HTTPError, URLError

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from scripts import import_catalog as catalog
from scripts import upload_catalog as uploader

FIXTURES = ROOT / 'test/fixtures/catalog'
HTML = (FIXTURES / 'subject.html').read_text()
INDEX = (FIXTURES / 'index.html').read_text()
STAMP = '2026-09-11T12:00:00Z'


def parse(html=HTML):
    return catalog.parse_subject(html, 'ME', '2026-2028', catalog.BASE_URL + '/courses/me/', STAMP, 'San Luis Obispo')


class FakeFetcher:
    offline = True

    def fetch(self, url):
        html = INDEX if url == catalog.INDEX_URL else HTML
        return {'html': html, 'retrievedAt': STAMP, 'sha256': 'test-sha'}


class CatalogTests(unittest.TestCase):
    def test_discovery_deduplicates_and_excludes_solano_and_external_links(self):
        rows = catalog.discover_subjects(INDEX, '2026-2028')
        self.assertEqual([row['subject'] for row in rows], ['AERO', 'ME'])
        all_rows = catalog.discover_subjects(INDEX, '2026-2028', 'all')
        self.assertEqual([row['subject'] for row in all_rows], ['AERO', 'CHE', 'ME'])
        self.assertEqual(all_rows[1]['campus'], 'Solano')

    def test_fields_and_inline_punctuation_survive_html_parsing(self):
        course = parse()[0]
        self.assertEqual(course['title'], 'Mechanics & Design')
        self.assertEqual(course['description'], 'Learn mechanics, forces & design. Formerly ME 123.')
        self.assertEqual(course['units'], '1-3')
        self.assertEqual(course['term'], 'F, SP')
        self.assertEqual(course['prerequisite'], 'MATH 1000.')
        self.assertEqual(course['corequisite'], 'PHYS 1000.')
        self.assertEqual(course['concurrent'], 'LAB 1000.')
        self.assertEqual(course['recommended'], 'Preparation.')
        self.assertEqual(course['geArea'], 'Area 2 Earlier catalog: Area B')
        self.assertEqual(course['gradingBasis'], 'CR/NC')
        self.assertEqual(course['retrievedAt'], STAMP)
        self.assertEqual(course['sourceUrl'], catalog.BASE_URL + '/courses/me/')

    def test_ids_do_not_change_when_course_text_changes(self):
        a = parse()[0]
        b = parse(HTML.replace('Learn', 'Explore'))[0]
        self.assertEqual(a['id'], b['id'])
        b['catalogEdition'] = '2028-2030'
        self.assertNotEqual(a['id'], catalog.course_id(b))

    def test_bad_or_changed_pages_cannot_silently_drop_courses(self):
        for html in [HTML.replace('2026-2028', '2028-2030'), HTML.replace('courseblock__description', 'new-description'), HTML.replace('ME 1123', 'OTHER 1123'), HTML + HTML, '<html>Unavailable</html>']:
            with self.subTest(html=html[:40]):
                with self.assertRaises(ValueError):
                    parse(html)

    def test_unknown_requirement_label_remains_in_source_details(self):
        course = parse(HTML.replace('Prerequisite:', 'Prerequisite or concurrent:'))[0]
        self.assertIn('Prerequisite or concurrent: MATH 1000.', course['catalogDetails'])
        self.assertEqual(course['prerequisite'], '')

    def test_unknown_subject_is_rejected(self):
        with self.assertRaisesRegex(ValueError, 'Subjects absent'):
            catalog.build_catalog(FakeFetcher(), '2026-2028', requested_subjects=['UNKNOWN'])

    def test_partial_import_does_not_replace_existing_snapshot(self):
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / 'catalog.json'
            output.write_text('{"previous":"intact"}')
            with patch.object(catalog, 'CatalogFetcher', return_value=FakeFetcher()), contextlib.redirect_stderr(io.StringIO()):
                # FakeFetcher returns ME HTML for AERO: that subject must fail.
                result = catalog.main(['--output', str(output)])
            self.assertEqual(result, 1)
            self.assertEqual(json.loads(output.read_text()), {'previous': 'intact'})
            report = json.loads(output.with_suffix('.report.json').read_text())
            self.assertFalse(report['complete'])
            self.assertEqual(report['subjectsRequested'], 2)
            self.assertEqual(report['subjectsImported'], 1)

    def test_offline_missing_cache_never_uses_network(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(catalog, 'fetch_url') as network:
            with self.assertRaisesRegex(ValueError, 'No cached page'):
                catalog.CatalogFetcher(directory, offline=True).fetch(catalog.INDEX_URL)
            network.assert_not_called()

    def test_fetch_respects_robots_and_reuses_cache(self):
        class Response(io.BytesIO):
            def __init__(self, url, body):
                super().__init__(body.encode())
                self.url = url
        with tempfile.TemporaryDirectory() as directory, patch.object(catalog, 'fetch_url') as network:
            network.side_effect = lambda request, timeout: Response(request.full_url, 'User-agent: *\nDisallow: /courses/aero/\n' if request.full_url.endswith('robots.txt') else INDEX)
            fetcher = catalog.CatalogFetcher(directory, delay=0)
            first = fetcher.fetch(catalog.INDEX_URL)
            self.assertEqual(fetcher.fetch(catalog.INDEX_URL), first)
            self.assertEqual(network.call_count, 2)
            with self.assertRaisesRegex(ValueError, 'disallows'):
                fetcher.fetch(catalog.BASE_URL + '/courses/aero/')
            cached = catalog.CatalogFetcher(directory, offline=True)
            self.assertEqual(cached.fetch(catalog.INDEX_URL), first)
            self.assertEqual(network.call_count, 2)


class UploadTests(unittest.TestCase):
    def snapshot(self):
        return {'schemaVersion': 1, 'complete': True, 'catalogEdition': '2026-2028', 'courseCount': 1, 'courses': parse()}

    def test_rejects_incomplete_duplicate_or_modified_identity(self):
        base = self.snapshot()
        bad_id = copy.deepcopy(base)
        bad_id['courses'][0]['id'] = 'wrong'
        for value in [{**base, 'complete': False}, {**base, 'courseCount': 2}, {**base, 'courses': base['courses'] * 2, 'courseCount': 2}, bad_id]:
            with self.assertRaises(ValueError):
                uploader.validate_snapshot(value)

    def test_dry_run_needs_no_credentials_or_network(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(uploader, 'upload_courses') as upload, contextlib.redirect_stdout(io.StringIO()):
            output = Path(directory) / 'catalog.json'
            output.write_text(json.dumps(self.snapshot()))
            self.assertEqual(uploader.main([str(output)]), 0)
            upload.assert_not_called()

    def test_upload_batches_and_retries_same_ids(self):
        calls = []
        def send(request, timeout):
            batch = json.loads(request.data)['courses']
            calls.append(batch)
            if len(calls) == 1:
                raise HTTPError(request.full_url, 503, 'Unavailable', {}, None)
            response = io.BytesIO(json.dumps({'count': len(batch)}).encode())
            response.status = 201
            return response
        rows = [{'id': str(i)} for i in range(27)]
        with contextlib.redirect_stdout(io.StringIO()):
            count = uploader.upload_courses(rows, 'https://example.com/prod', 'test-password', send, sleep=lambda _: None)
        self.assertEqual(count, 27)
        self.assertEqual([len(batch) for batch in calls], [25, 25, 2])
        self.assertEqual(calls[0], calls[1])

    def test_unauthorized_upload_stops_without_leaking_credentials(self):
        def send(request, timeout):
            raise HTTPError(request.full_url, 403, 'private-password', {}, None)
        with self.assertRaisesRegex(ValueError, 'HTTP 403') as error:
            uploader.upload_courses([{}], 'https://example.com', 'private-password', send)
        self.assertNotIn('private-password', str(error.exception))

    def test_rejects_insecure_destination_before_sending_credentials(self):
        with self.assertRaises(ValueError):
            uploader.upload_courses([{}], 'http://example.com', 'test-password')


if __name__ == '__main__':
    unittest.main()

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
from scripts import extract_sections as s

FIXTURES = ROOT / 'test/fixtures/sections'
RESULTS = (FIXTURES / 'results.html').read_text()
DETAIL = (FIXTURES / 'detail.html').read_text()
STAMP = '2026-10-28T07:00:00.000Z'
SCOPE = {'institution': 'SLCMP', 'termId': '2268', 'campus': 'MAIN', 'subject': 'BIO',
         'courseNumber': '1111', 'includeClosed': True}
META = {'subjectLabel': 'Biology', 'campusLabel': 'Main Cal Poly Campus', 'robotsStatus': 'not_published_404'}
LABEL = 'Cal Poly | Fall Semester 2026'


def results(html=RESULTS):
    return s.parse_results(s.decode_page(html), SCOPE, META)


def detail(html=DETAIL):
    return s.parse_detail(s.decode_page(html), results()[0][0], SCOPE, LABEL)


class FakeSession:
    def __init__(self, missing_link=False, bad_second=False, timeout=False):
        self.calls = []
        self.missing_link, self.bad_second, self.timeout = missing_link, bad_second, timeout

    def start(self, scope):
        return META

    def submit(self, action, updates=None):
        self.calls.append((action, updates))
        if self.timeout:
            raise URLError('simulated connection outage')
        if action in (s.SEARCH, s.BACK):
            return s.decode_page(RESULTS)
        # Synthetic variants of the sanitized real S01 page are only test fixtures.
        i = int(action.split('$')[1])
        html = DETAIL.replace('6369', str(6369 + i)).replace('S01', f'S0{i + 1}')
        if self.missing_link:
            html = html.replace('Course Materials</a>', 'Other link</a>')
        if self.bad_second and i == 1:
            html = html.replace('term_id-1=2268', 'term_id-1=2262')
        return s.decode_page(html)


class SectionsTests(unittest.TestCase):
    def test_all_statuses_are_requested_and_three_sections_parsed(self):
        rows, label = results()
        self.assertEqual([r['crn'] for r in rows], ['6369', '6370', '6371'])
        self.assertEqual(label, LABEL)
        self.assertEqual(s.search_updates(SCOPE)['SSR_CLSRCH_WRK_SSR_OPEN_ONLY$chk$4'], 'N')
        self.assertEqual(detail()['status'], 'Closed')

    def test_observed_materials_link_and_instructor_are_preserved(self):
        row = detail()
        self.assertEqual(row['meetings'][0]['instructor'], 'Haley Moniz')
        self.assertEqual(row['materialsUrl'], 'https://www.bkstr.com/webApp/discoverView?bookstore_id-1=2020&term_id-1=2268&crn-1=6369')
        self.assertEqual(row['materialsVerificationStatus'], 'not_checked')
        self.assertNotIn('isbn', row)

    def test_missing_link_is_unknown_not_no_materials(self):
        row = detail(DETAIL.replace('Course Materials</a>', 'Other link</a>'))
        self.assertEqual(row['materialsLinkStatus'], 'not_listed')
        self.assertNotIn('materialsUrl', row)
        self.assertEqual(row['materialsVerificationStatus'], 'not_checked')
        with self.assertRaises(s.ExtractionError):
            detail(DETAIL.replace('win0divSSR_CLS_DTL_WRK_SSR_GROUP2', 'changed-panel'))

    def test_truncation_duplicates_wrong_scope_and_open_only_fail_closed(self):
        for html in [RESULTS.replace('3 class section(s)', '4 class section(s)'),
                     RESULTS.replace('6371', '6370'), RESULTS.replace('>No<', '>Yes<'),
                     RESULTS.replace('BIO 1111', 'BIO 1112'), RESULTS.replace('Main Cal Poly Campus', 'Solano Campus'),
                     '<p>Service temporarily unavailable</p>']:
            with self.subTest(html=html[:60]), self.assertRaises(s.ExtractionError):
                results(html)

    def test_wrong_link_identity_or_host_is_never_accepted(self):
        for old, new in [('term_id-1=2268', 'term_id-1=2262'), ('crn-1=6369', 'crn-1=6370'),
                         ('bookstore_id-1=2020', 'bookstore_id-1=9999'), ('www.bkstr.com', 'example.com'),
                         ('https://www.bkstr.com', 'http://www.bkstr.com')]:
            with self.subTest(new=new), self.assertRaises(s.ExtractionError):
                detail(DETAIL.replace(old, new))

    def test_wrong_detail_crn_section_term_and_campus_are_rejected(self):
        for old, new in [('>6369<', '>6370<'), ('S01', 'S02'),
                         ('Fall Semester 2026', 'Spring Semester 2027'), ('>MAIN<', '>SOLA<')]:
            with self.subTest(new=new), self.assertRaises(s.ExtractionError):
                detail(DETAIL.replace(old, new))

    def test_people_soft_large_results_xml_is_decoded_without_running_scripts(self):
        xml = "<?xml version='1.0'?><PAGE><GENSCRIPT><![CDATA[throw new Error('not executable')]]></GENSCRIPT>"
        xml += '<FIELD id="win0divPAGECONTAINER"><![CDATA[' + RESULTS + ']]></FIELD></PAGE>'
        self.assertEqual(s.parse_results(s.decode_page(xml), SCOPE, META), results())
        with self.assertRaises(s.ExtractionError):
            s.decode_page("<?xml version='1.0'?><PAGE><FIELD id='only-a-diff'>x</FIELD></PAGE>")

    def test_blocks_and_login_are_failures_not_empty_results(self):
        for html in ['<p>Please verify you are a human</p>', '<p>Access to this page has been denied</p>',
                     '<form><input type="password"></form>']:
            with self.subTest(html=html), self.assertRaises(s.ExtractionError):
                s.decode_page(html)

    def test_evidence_does_not_contain_session_values_scripts_or_events(self):
        html = '<form action="/session"><input type="hidden" name="ICSID" value="SECRET"><script>SECRET</script>'
        html += '<a onclick="SECRET" href="javascript:SECRET" id="safe">Public</a></form>'
        evidence = s.evidence_html(s.decode_page(html))
        self.assertNotIn('SECRET', evidence)
        self.assertNotIn('ICSID', evidence)
        self.assertIn('Public', evidence)

    def test_reconcile_is_idempotent_and_retains_content_update_timestamp(self):
        row = detail()
        row['source'] = {'retrievedAt': STAMP}
        first = [copy.deepcopy(row)]
        self.assertEqual(len(s.reconcile(first, None)['added']), 1)
        second = [copy.deepcopy(row)]
        second[0]['source']['retrievedAt'] = '2026-10-29T07:00:00.000Z'
        changes = s.reconcile(second, {'sections': first})
        self.assertEqual(changes['unchanged'], [row['id']])
        self.assertEqual(second[0]['updatedAt'], STAMP)
        self.assertNotEqual(second[0]['lastSeenAt'], STAMP)
        self.assertEqual(s.content_hash(first), s.content_hash(second))
        second[0]['status'] = 'Open'
        self.assertEqual(s.reconcile(second, {'sections': first})['changed'], [row['id']])
        self.assertEqual(second[0]['updatedAt'], second[0]['lastSeenAt'])
        self.assertEqual(s.reconcile([], {'sections': first})['removed'], [row['id']])

    def run_cli(self, output, session=None, extra=None):
        with patch.object(s, 'Session', return_value=session or FakeSession()), contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
            return s.main(['--term', '2268', '--subject', 'BIO', '--course', '1111', '--output', str(output)] + (extra or []))

    def test_fresh_runs_do_not_duplicate_and_capture_replays_without_network(self):
        with tempfile.TemporaryDirectory() as tmp:
            output = Path(tmp) / 'pilot.json'
            self.assertEqual(self.run_cli(output), 0)
            first = json.loads(output.read_text())
            self.assertEqual(self.run_cli(output), 0)
            second = json.loads(output.read_text())
            report = json.loads(output.with_suffix('.report.json').read_text())
            self.assertEqual(first['contentSha256'], second['contentSha256'])
            self.assertEqual(second['sectionCount'], 3)
            self.assertEqual(report['changes'], {'added': 0, 'changed': 0, 'unchanged': 3, 'removed': 0})
            with patch.object(s, 'Session', side_effect=AssertionError('Replay created a network session')), contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
                replay = Path(tmp) / 'replay.json'
                self.assertEqual(s.main(['--term', '2268', '--subject', 'BIO', '--course', '1111',
                                         '--output', str(replay), '--replay', report['capturePath']]), 0)
            self.assertEqual(json.loads(replay.read_text())['contentSha256'], second['contentSha256'])
            self.assertEqual(self.run_cli(output, extra=['--replay', report['capturePath']]), 1)

    def test_partial_failure_retains_last_good_snapshot_and_records_failure_source(self):
        with tempfile.TemporaryDirectory() as tmp:
            output = Path(tmp) / 'pilot.json'
            self.assertEqual(self.run_cli(output), 0)
            previous = output.read_bytes()
            self.assertEqual(self.run_cli(output, FakeSession(bad_second=True)), 1)
            self.assertEqual(output.read_bytes(), previous)
            report = json.loads(output.with_suffix('.report.json').read_text())
            self.assertFalse(report['snapshotUpdated'])
            self.assertEqual(report['sectionsExtracted'], 2)
            self.assertEqual(report['failures'][0]['crn'], '6370')
            self.assertEqual(report['failures'][0]['code'], 'invalid_materials_link')
            self.assertIn('retrievedAt', report['failures'][0]['source'])
            self.assertTrue(report['failures'][0]['failedAt'])

    def test_outage_writes_report_and_keeps_prior_snapshot(self):
        with tempfile.TemporaryDirectory() as tmp:
            output = Path(tmp) / 'pilot.json'
            self.assertEqual(self.run_cli(output), 0)
            previous = output.read_bytes()
            self.assertEqual(self.run_cli(output, FakeSession(timeout=True)), 1)
            self.assertEqual(output.read_bytes(), previous)
            report = json.loads(output.with_suffix('.report.json').read_text())
            self.assertEqual(report['failures'][0]['code'], 'connection_failed')
            self.assertEqual(len(list((Path(tmp) / '.runs/pilot').glob('*/report.json'))), 2)

    def test_replay_rejects_corrupt_pages_and_wrong_scope(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / 'capture.json'
            capture = s.Capture(FakeSession(), path, SCOPE)
            capture.start(SCOPE)
            capture.step(s.SEARCH, s.search_updates(SCOPE))
            capture.finish()
            with self.assertRaises(s.ExtractionError):
                s.Replay(path).start({**SCOPE, 'termId': '2274'})
            (Path(tmp) / '0000.html').write_text('tampered')
            replay = s.Replay(path)
            replay.start(SCOPE)
            with self.assertRaisesRegex(s.ExtractionError, 'checksum'):
                replay.step(s.SEARCH, s.search_updates(SCOPE))

    def test_replay_checks_exact_crlf_bytes_from_live_html(self):
        class CRLFSession(FakeSession):
            def submit(self, action, updates=None):
                return s.decode_page('<p>First\r\nSecond</p>')
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / 'capture.json'
            capture = s.Capture(CRLFSession(), path, SCOPE)
            capture.start(SCOPE)
            capture.step(s.SEARCH)
            capture.finish()
            replay = s.Replay(path)
            replay.start(SCOPE)
            root, _ = replay.step(s.SEARCH)
            self.assertEqual(s.normalize(root.text()), 'First Second')

    def test_large_results_prompt_is_explicitly_handled(self):
        class LargeSession(FakeSession):
            def submit(self, action, updates=None):
                if action == s.SEARCH:
                    return s.decode_page('<p>Your search will return over 50 classes, would you like to continue?</p>')
                return super().submit(s.SEARCH if action == '#ICSave' else action, updates)
        with tempfile.TemporaryDirectory() as tmp:
            self.assertEqual(self.run_cli(Path(tmp) / 'pilot.json', LargeSession()), 0)

    def test_explicit_empty_results_are_distinct_from_a_failed_request(self):
        page = '<span id="DERIVED_CLSMSG_ERROR_TEXT">The search returns no results that match the criteria specified.</span>'
        page += '<span id="SLO_SS_TERM_VW_DESCR">Fall Semester 2026</span>'
        self.assertEqual(results(page), ([], LABEL))
        with self.assertRaises(s.ExtractionError):
            results('<p>The search returns no results</p>')

    def test_changed_results_during_run_do_not_publish_partial_snapshot(self):
        class ChangedSession(FakeSession):
            def submit(self, action, updates=None):
                if action == s.BACK:
                    return s.decode_page(RESULTS.replace('6371', '9999'))
                return super().submit(action, updates)
        with tempfile.TemporaryDirectory() as tmp:
            output = Path(tmp) / 'pilot.json'
            self.assertEqual(self.run_cli(output), 0)
            before = output.read_bytes()
            self.assertEqual(self.run_cli(output, ChangedSession()), 1)
            self.assertEqual(output.read_bytes(), before)
            report = json.loads(output.with_suffix('.report.json').read_text())
            self.assertEqual(report['failures'][0]['code'], 'results_changed')

    def test_interrupt_and_http_rate_limit_are_recorded_as_failures(self):
        for error, code in [(KeyboardInterrupt(), 'interrupted'),
                            (HTTPError(s.SOURCE, 429, 'rate limited', {}, None), 'rate_limited')]:
            with self.subTest(code=code), tempfile.TemporaryDirectory() as tmp:
                output = Path(tmp) / 'pilot.json'
                session = FakeSession()
                with patch.object(session, 'start', side_effect=error):
                    self.assertEqual(self.run_cli(output, session), 1)
                self.assertFalse(output.exists())
                report = json.loads(output.with_suffix('.report.json').read_text())
                self.assertEqual(report['failures'][0]['code'], code)

    def test_robots_disallow_stops_before_starting_search(self):
        session = s.Session()
        with patch.object(session, 'request', return_value='User-agent: *\nDisallow: /') as fetch:
            with self.assertRaisesRegex(s.ExtractionError, 'robots.txt disallows'):
                session.start(SCOPE)
            self.assertEqual(fetch.call_count, 1)

    def test_redirects_cannot_leave_public_search_or_enter_login(self):
        redirect = s.PublicRedirects()
        for url in ['https://example.com/', s.SOURCE + '?cmd=login', s.SOURCE.replace('https:', 'http:')]:
            with self.subTest(url=url), self.assertRaises(s.ExtractionError):
                redirect.redirect_request(None, None, 302, '', {}, url)


if __name__ == '__main__':
    unittest.main()

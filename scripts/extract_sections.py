#!/usr/bin/env python3
"""Extract public Cal Poly sections and observed materials links; never visit the bookstore.

Standard library only. No credentials, AWS/database writes, or textbook inference.
"""
import argparse
from collections import Counter
from datetime import datetime, timezone
from hashlib import sha256
from html import escape
from http.cookiejar import CookieJar
import json
from pathlib import Path
import re
import sys
import time
from urllib.error import HTTPError, URLError
from urllib.parse import parse_qs, urlencode, urlparse
from urllib.request import HTTPRedirectHandler, HTTPCookieProcessor, Request, build_opener
from urllib.robotparser import RobotFileParser
from uuid import uuid4
import xml.etree.ElementTree as ET

try:
    from .import_catalog import CatalogHTML, atomic_json, normalize
except ImportError:
    from import_catalog import CatalogHTML, atomic_json, normalize

ROOT = Path(__file__).resolve().parents[1]
SOURCE = 'https://cmsweb.pscs.calpoly.edu/psc/CSLOPRD/EMPLOYEE/SA/c/COMMUNITY_ACCESS.CLASS_SEARCH.GBL'
ROBOTS = 'https://cmsweb.pscs.calpoly.edu/robots.txt'
USER_AGENT = 'CampusEssentials/0.1 (public class schedule extraction pilot)'
INSTITUTION = 'CLASS_SRCH_WRK2_INSTITUTION$31$'
TERM = 'SLO_SS_DERIVED_STRM'
CAMPUS = 'SSR_CLSRCH_WRK_CAMPUS$0'
SUBJECT = 'SSR_CLSRCH_WRK_SUBJECT_SRCH$1'
NUMBER = 'SSR_CLSRCH_WRK_CATALOG_NBR$2'
SEARCH = 'CLASS_SRCH_WRK2_SSR_PB_CLASS_SRCH'
BACK = 'CLASS_SRCH_WRK2_SSR_PB_BACK'


def now():
    return datetime.now(timezone.utc).isoformat(timespec='milliseconds').replace('+00:00', 'Z')


def display_path(path):
    resolved = Path(path).resolve()
    return str(resolved.relative_to(ROOT)) if resolved.is_relative_to(ROOT) else str(resolved)


class ExtractionError(ValueError):
    def __init__(self, code, message):
        super().__init__(message)
        self.code = code


def require(condition, message, code='structure_changed'):
    if not condition:
        raise ExtractionError(code, message)


def by_id(root, key):
    return next((n for n in root.walk() if n.attrs.get('id') == key), None)


def field(root, key, required=True):
    n = by_id(root, key)
    value = normalize(n.text()) if n else ''
    require(value or not required, f'Missing field {key}')
    return value


def decode_page(raw):
    """The >50 results confirmation uses a PeopleSoft XML envelope, not HTML."""
    if raw.lstrip().startswith('<?xml'):
        require('<!DOCTYPE' not in raw.upper(), 'Unexpected XML declaration')
        try:
            envelope = ET.fromstring(raw)
        except ET.ParseError as error:
            raise ExtractionError('structure_changed', 'Malformed PeopleSoft XML response') from error
        fields = {n.attrib.get('id'): n.text or '' for n in envelope if n.tag == 'FIELD'}
        require('win0divPAGECONTAINER' in fields, 'Unsupported partial XML update; refusing stale page data')
        raw = fields.get('win0divPSHIDDENFIELDS', '') + fields['win0divPAGECONTAINER']
    root = CatalogHTML(raw).root
    visible = normalize(root.text()).lower()
    if any(phrase in visible for phrase in ('verify you are a human', 'access to this page has been denied', 'captcha', 'access denied')):
        raise ExtractionError('access_blocked', 'Public schedule blocked automated access; no bypass attempted')
    if any(n.tag == 'input' and n.attrs.get('type') == 'password' for n in root.walk()):
        raise ExtractionError('login_required', 'Public schedule returned a login form')
    return root


def form_values(root):
    values = {}
    for n in root.walk():
        key = n.attrs.get('name')
        if not key or 'disabled' in n.attrs:
            continue
        if n.tag == 'input' and n.attrs.get('type') not in ('button', 'submit', 'checkbox', 'radio'):
            values[key] = n.attrs.get('value', '')
        elif n.tag == 'select':
            options = [o for o in n.walk() if o.tag == 'option']
            if options:
                selected = next((o for o in options if 'selected' in o.attrs), options[0])
                values[key] = selected.attrs.get('value', '')
    return values


def option_label(root, key, value):
    select = by_id(root, key)
    option = next((n for n in select.walk() if n.tag == 'option' and n.attrs.get('value') == value), None) if select else None
    require(option is not None, f'{key}: option {value!r} is not offered', 'invalid_scope')
    return normalize(option.text())


def evidence_html(node):
    """Save public content only. Session tokens, scripts, events and form values stay in memory."""
    if isinstance(node, str):
        return escape(node)
    if node.tag in ('script', 'style', 'input', 'select', 'textarea', 'head'):
        return ''
    children = ''.join(evidence_html(c) for c in node.children)
    if node.tag in ('document', 'form'):
        return children
    attrs = {k: v for k, v in node.attrs.items() if k in ('id', 'alt', 'title') and v is not None}
    href = node.attrs.get('href', '')
    if node.tag == 'a' and href.startswith('https://www.bkstr.com/webApp/discoverView?'):
        attrs['href'] = href
    attributes = ''.join(f' {k}="{escape(v, quote=True)}"' for k, v in attrs.items())
    return f'<{node.tag}{attributes}>' + ('' if node.tag in CatalogHTML.VOID else children + f'</{node.tag}>')


class PublicRedirects(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        parsed, expected = urlparse(newurl), urlparse(SOURCE)
        require(parsed.scheme == 'https' and parsed.netloc == expected.netloc and parsed.path == expected.path,
                'Redirect outside the public class-search endpoint', 'access_blocked')
        require(not any(k.lower() in ('cmd', 'errorpg') for k in parse_qs(parsed.query)),
                'Login/error redirect from the public schedule', 'access_blocked')
        return super().redirect_request(req, fp, code, msg, headers, newurl)


class Session:
    def __init__(self, delay=1.0):
        self.delay, self.last_request, self.request_count = delay, 0, 0
        self.opener = build_opener(PublicRedirects(), HTTPCookieProcessor(CookieJar()))
        self.root = None
        self.robots_status = 'not_checked'

    def request(self, url, data=None):
        require(self.request_count < 1000, 'Request budget exceeded', 'request_limit')
        time.sleep(max(0, self.delay - (time.monotonic() - self.last_request)))
        self.last_request = time.monotonic()
        self.request_count += 1
        request = Request(url, data=urlencode(data).encode() if data is not None else None,
                          headers={'User-Agent': USER_AGENT, 'Accept': 'text/html,application/xml,text/plain'})
        # Never retry a POST blindly: a timeout may have advanced the server session.
        with self.opener.open(request, timeout=40) as response:
            raw = response.read(8_000_001)
            require(len(raw) <= 8_000_000, 'Response exceeds 8 MB limit', 'response_too_large')
            return raw.decode('utf-8-sig')

    def start(self, scope):
        try:
            rules = self.request(ROBOTS)
        except HTTPError as error:
            if error.code != 404:
                raise
            self.robots_status = 'not_published_404'
        else:
            robot = RobotFileParser()
            robot.parse(rules.splitlines())
            require(robot.can_fetch(USER_AGENT, SOURCE), 'robots.txt disallows public class search', 'robots_disallowed')
            self.delay = max(self.delay, robot.crawl_delay(USER_AGENT) or 0)
            self.robots_status = 'allowed'
        self.root = decode_page(self.request(SOURCE))
        require(by_id(self.root, INSTITUTION) is not None, 'Public search form is missing')
        self.submit(INSTITUTION, {INSTITUTION: 'SLCMP'})
        return {'subjectLabel': option_label(self.root, SUBJECT, scope['subject']),
                'campusLabel': option_label(self.root, CAMPUS, scope['campus']),
                'robotsStatus': self.robots_status}

    def submit(self, action, updates=None):
        values = form_values(self.root)
        require('ICStateNum' in values and 'ICSID' in values, 'Session form state missing', 'session_lost')
        values.update(updates or {})
        values['ICAction'] = action
        self.root = decode_page(self.request(SOURCE, values))
        return self.root


class Capture:
    """A fresh network session per run, with sanitized, checksum-verified offline evidence."""
    offline = False

    def __init__(self, session, path, scope):
        self.session, self.path = session, Path(path)
        self.data = {'schemaVersion': 1, 'scope': scope, 'complete': False, 'steps': []}

    def start(self, scope):
        metadata = self.session.start(scope)
        self.data['metadata'] = metadata
        atomic_json(self.path, self.data)
        return metadata

    def step(self, action, updates=None):
        root = self.session.submit(action, updates)
        html = evidence_html(root)
        stamp = now()
        index = len(self.data['steps'])
        file = f'{index:04d}.html'
        self.path.parent.mkdir(parents=True, exist_ok=True)
        (self.path.parent / file).write_text(html, encoding='utf-8')
        source = {'sourceUrl': SOURCE, 'action': action, 'retrievedAt': stamp,
                  'sha256': sha256(html.encode()).hexdigest(), 'evidenceFile': file,
                  'capturePath': display_path(self.path)}
        self.data['steps'].append({'action': action, 'updates': updates or {}, 'source': source})
        atomic_json(self.path, self.data)
        return root, source

    def finish(self):
        self.data['complete'] = True
        atomic_json(self.path, self.data)


class Replay:
    offline = True

    def __init__(self, path):
        self.path, self.position = Path(path), 0
        self.data = json.loads(self.path.read_text(encoding='utf-8'))

    def start(self, scope):
        require(self.data.get('schemaVersion') == 1 and self.data.get('complete') is True,
                'Replay needs a complete version-1 capture', 'invalid_capture')
        require(self.data['scope'] == scope, 'Replay scope differs from requested scope', 'invalid_capture')
        return self.data['metadata']

    def step(self, action, updates=None):
        require(self.position < len(self.data['steps']), 'Replay ended before extraction completed', 'invalid_capture')
        step = self.data['steps'][self.position]
        self.position += 1
        require(step['action'] == action and step['updates'] == (updates or {}), 'Replay action mismatch', 'invalid_capture')
        source = step['source']
        file = source['evidenceFile']
        require(re.fullmatch(r'\d{4}\.html', file), 'Invalid evidence filename', 'invalid_capture')
        # Hash the exact saved bytes; text-mode reads normalize live CRLF responses.
        html = (self.path.parent / file).read_bytes().decode('utf-8')
        require(sha256(html.encode()).hexdigest() == source['sha256'], 'Evidence checksum mismatch', 'invalid_capture')
        return decode_page(html), source

    def finish(self):
        require(self.position == len(self.data['steps']), 'Replay has unconsumed steps', 'invalid_capture')


def search_updates(scope):
    return {TERM: scope['termId'], CAMPUS: scope['campus'], SUBJECT: scope['subject'],
            NUMBER: scope['courseNumber'] or '', 'SSR_CLSRCH_WRK_SSR_EXACT_MATCH1$2': 'E',
            'SSR_CLSRCH_WRK_SSR_OPEN_ONLY$chk$4': 'N'}


def parse_results(root, scope, metadata):
    visible = normalize(root.text())
    if field(root, 'DERIVED_CLSMSG_ERROR_TEXT', False) == 'The search returns no results that match the criteria specified.':
        return [], 'Cal Poly | ' + field(root, 'SLO_SS_TERM_VW_DESCR')
    require('Show Open Classes Only: No' in visible, 'Search did not include closed/waitlisted sections', 'scope_mismatch')
    require(f"Course Subject: {metadata['subjectLabel']}" in visible and f"Campus: {metadata['campusLabel']}" in visible,
            'Returned search scope differs from requested subject/campus', 'scope_mismatch')
    match = re.search(r'(\d+) class section\(s\) found', visible)
    require(match is not None, 'Missing result count; response may be an error or a result-limit warning')
    count = int(match.group(1))
    rows = []
    groups = [n for n in root.walk() if re.fullmatch(r'win0divSSR_CLSRSLT_WRK_GROUPBOX2\$\d+', n.attrs.get('id', ''))]
    for group in groups:
        heading = next((n for n in group.walk() if re.fullmatch(r'SSR_CLSRSLT_WRK_GROUPBOX2\$\d+', n.attrs.get('id', ''))), None)
        title = heading.attrs.get('title', '') if heading else ''
        course = re.fullmatch(r'Collapse section ([A-Z]{2,5}) (\d{3,4}[A-Z]?) - (.+)', title)
        require(course is not None, f'Unexpected course heading {title!r}')
        subject, number, name = course.groups()
        require(subject == scope['subject'] and (not scope['courseNumber'] or number == scope['courseNumber']),
                'Result includes a course outside the requested scope', 'scope_mismatch')
        for n in group.walk():
            if n.tag != 'a' or not re.fullmatch(r'MTG_CLASS_NBR\$\d+', n.attrs.get('id', '')):
                continue
            action = n.attrs['id']
            suffix = action.split('$')[1]
            crn = normalize(n.text())
            section = field(group, 'MTG_CLASSNAME$' + suffix)
            section_match = re.fullmatch(r'([A-Z]?\d+)-([A-Z]+)\s+(.+)', section)
            require(re.fullmatch(r'\d+', crn) and section_match, f'Invalid CRN/section {crn}/{section}')
            rows.append({'subject': subject, 'number': number, 'title': name, 'crn': crn,
                         'sectionNumber': section_match[1], 'component': section_match[2], 'session': section_match[3],
                         '_action': action})
    require(len(rows) == count and len({r['crn'] for r in rows}) == count,
            f'Expected {count} sections but parsed {len(rows)}; truncated, paginated or duplicate results', 'incomplete_results')
    return rows, field(root, 'DERIVED_CLSRCH_SSS_PAGE_KEYDESCR')


def parse_detail(root, row, scope, term_label):
    require(field(root, 'SSR_CLS_DTL_WRK_CLASS_NBR') == row['crn'], 'Detail CRN mismatch', 'scope_mismatch')
    require(field(root, 'SSR_CLS_DTL_WRK_CAMPUS') == scope['campus'], 'Detail campus mismatch', 'scope_mismatch')
    heading = field(root, 'DERIVED_CLSRCH_DESCR200')
    require(heading.startswith(f"{row['subject']} {row['number']} - {row['sectionNumber']} "), 'Detail course/section mismatch', 'scope_mismatch')
    require(field(root, 'DERIVED_CLSRCH_SSS_PAGE_KEYDESCR').startswith(term_label + ' |'), 'Detail term mismatch', 'scope_mismatch')
    panel = by_id(root, 'win0divSSR_CLS_DTL_WRK_SSR_GROUP2')
    require(panel is not None and 'Textbook/Other Materials' in normalize(panel.text()), 'Materials panel missing; cannot infer absent link')
    links = [n.attrs.get('href', '') for n in panel.walk() if n.tag == 'a' and normalize(n.text()) == 'Course Materials']
    require(len(links) <= 1, 'Ambiguous materials links')
    link = links[0] if links else None
    if link:
        parsed = urlparse(link)
        query = parse_qs(parsed.query)
        require(parsed.scheme == 'https' and parsed.netloc == 'www.bkstr.com' and parsed.path == '/webApp/discoverView'
                and not parsed.fragment and query == {'bookstore_id-1': ['2020'], 'term_id-1': [scope['termId']], 'crn-1': [row['crn']]},
                'Materials link does not match school, term and CRN', 'invalid_materials_link')
    meetings = []
    for n in root.walk():
        match = re.fullmatch(r'MTG_SCHED\$(\d+)', n.attrs.get('id', ''))
        if match:
            suffix = match[1]
            meetings.append({'daysAndTimes': normalize(n.text()), 'room': field(root, 'MTG_LOC$' + suffix, False),
                             'instructor': field(root, 'MTG_INSTR$' + suffix, False), 'dates': field(root, 'MTG_DATE$' + suffix, False)})
    identity = ['SLCMP', scope['termId'], scope['campus'], row['crn']]
    return {k: v for k, v in {
        **{k: v for k, v in row.items() if not k.startswith('_')},
        'id': 'scheduleSection:' + sha256(json.dumps(identity, separators=(',', ':')).encode()).hexdigest(),
        'termId': scope['termId'], 'termLabel': term_label.split(' | ', 1)[1], 'campus': scope['campus'],
        'status': field(root, 'SSR_CLS_DTL_WRK_SSR_DESCRSHORT'),
        'units': field(root, 'SSR_CLS_DTL_WRK_UNITS_RANGE'),
        'instructionMode': field(root, 'INSTRUCT_MODE_DESCR', False), 'meetings': meetings,
        'materialsLinkStatus': 'available' if link else 'not_listed', 'materialsUrl': link,
        'materialsVerificationStatus': 'not_checked',
    }.items() if v is not None}


def content_hash(records):
    content = [{k: v for k, v in row.items() if k not in ('source', 'firstSeenAt', 'updatedAt', 'lastSeenAt')} for row in records]
    return sha256(json.dumps(content, sort_keys=True, ensure_ascii=False, separators=(',', ':')).encode()).hexdigest()


def reconcile(records, previous):
    old = {r['id']: r for r in (previous or {}).get('sections', [])}
    delta = {'added': [], 'changed': [], 'unchanged': [], 'removed': sorted(set(old) - {r['id'] for r in records})}
    for row in records:
        stamp = row['source']['retrievedAt']
        prior = old.get(row['id'])
        equal = prior is not None and content_hash([row]) == content_hash([prior])
        row.update(firstSeenAt=prior['firstSeenAt'] if prior else stamp,
                   updatedAt=prior['updatedAt'] if equal else stamp, lastSeenAt=stamp)
        delta['unchanged' if equal else 'changed' if prior else 'added'].append(row['id'])
    return delta


def extract(client, scope, report):
    metadata = client.start(scope)
    report['sourceMetadata'] = metadata
    root, source = client.step(SEARCH, search_updates(scope))
    report['sources'].append(source)
    if 'Your search will return over 50 classes, would you like to continue?' in normalize(root.text()):
        root, source = client.step('#ICSave')
        report['sources'].append(source)
    rows, label = parse_results(root, scope, metadata)
    report['sectionsDiscovered'] = len(rows)
    report['termLabel'] = label
    records = []
    for i, row in enumerate(rows):
        report['activeSection'] = {k: row[k] for k in ('subject', 'number', 'sectionNumber', 'crn')}
        detail, evidence = client.step(row['_action'])
        report['sources'].append(evidence)
        try:
            record = parse_detail(detail, row, scope, label)
        except ExtractionError as error:
            report['failures'].append({**report['activeSection'], 'code': error.code, 'message': str(error),
                                       'failedAt': now(), 'source': evidence})
        else:
            record['source'] = {**evidence, 'query': scope, 'resultsSha256': source['sha256']}
            records.append(record)
        report['sectionsExtracted'] = len(records)
        if i == 0 or (i + 1) % 10 == 0 or i + 1 == len(rows):
            print(f"[{i + 1}/{len(rows)}] {row['subject']} {row['number']} {row['sectionNumber']} ({row['crn']})", file=sys.stderr, flush=True)
        if i + 1 < len(rows):
            back, _ = client.step(BACK)
            current, current_label = parse_results(back, scope, metadata)
            require(current == rows and current_label == label, 'Search results changed during extraction; rerun with a fresh session', 'results_changed')
    client.finish()
    report.pop('activeSection', None)
    return sorted(records, key=lambda r: (r['subject'], r['number'], r['sectionNumber'], r['crn']))


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--term', required=True, help='Official term code, e.g. 2268 (Fall Semester 2026)')
    parser.add_argument('--subject', default='BIO')
    parser.add_argument('--course', help='Omit to extract the entire subject')
    parser.add_argument('--campus', default='MAIN', choices=['MAIN', 'AHC', 'CCC', 'SOLA'])
    parser.add_argument('--output', type=Path)
    parser.add_argument('--replay', type=Path, help='Offline: replay an earlier capture.json, with checksum verification')
    parser.add_argument('--delay', type=float, default=1.0, help='Minimum interval between live requests; at least 1 second')
    args = parser.parse_args(argv)
    if not re.fullmatch(r'\d{4}', args.term) or not re.fullmatch(r'[A-Z]{2,5}', args.subject):
        parser.error('term must be four digits; subject must be 2–5 uppercase letters')
    if args.course and not re.fullmatch(r'\d{3,4}[A-Z]?', args.course):
        parser.error('course must be a 3/4-digit course number with optional letter suffix')
    if not 1 <= args.delay <= 60:
        parser.error('delay must be between 1 and 60 seconds')
    scope = {'institution': 'SLCMP', 'termId': args.term, 'campus': args.campus,
             'subject': args.subject, 'courseNumber': args.course, 'includeClosed': True}
    name = f"{args.term}-{args.campus}-{args.subject}" + (f'-{args.course}' if args.course else '')
    output = args.output or ROOT / 'data/sections' / (name + '.json')
    run_id = datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%S') + '-' + uuid4().hex[:8]
    run_dir = output.parent / '.runs' / output.stem / run_id
    capture_path = args.replay or run_dir / 'capture.json'
    report = {'schemaVersion': 1, 'runId': run_id, 'scope': scope, 'startedAt': now(), 'finishedAt': None,
              'sourceUrl': SOURCE, 'mode': 'replay' if args.replay else 'live', 'complete': False,
              'snapshotUpdated': False, 'sectionsDiscovered': None, 'sectionsExtracted': 0,
              'capturePath': display_path(capture_path), 'sources': [], 'failures': []}
    try:
        previous = json.loads(output.read_text(encoding='utf-8')) if output.exists() else None
        require(previous is None or previous.get('scope') == scope, 'Output belongs to a different scope; use another --output', 'scope_mismatch')
        if args.replay:
            require(previous is None or previous.get('mode') == 'replay', 'Replay cannot replace a live snapshot; choose a different --output', 'scope_mismatch')
        client = Replay(args.replay) if args.replay else Capture(Session(args.delay), capture_path, scope)
        records = extract(client, scope, report)
        if not report['failures']:
            delta = reconcile(records, previous)
            report.update(complete=True, contentSha256=content_hash(records), changes={k: len(v) for k, v in delta.items()},
                          missingMaterialsLinks=[r['crn'] for r in records if r['materialsLinkStatus'] == 'not_listed'])
            snapshot = {'schemaVersion': 1, 'scope': scope, 'sourceUrl': SOURCE, 'mode': report['mode'],
                        'capturePath': display_path(capture_path),
                        'generatedAt': now(), 'complete': True, 'contentSha256': report['contentSha256'],
                        'sectionCount': len(records), 'courseCount': len({r['number'] for r in records}),
                        'termLabel': report['termLabel'], 'sections': records}
            atomic_json(output, snapshot)
            report['snapshotUpdated'] = True
            report['sectionStatuses'] = dict(Counter(r['status'] for r in records))
            report['delta'] = delta
    except (ValueError, OSError, TimeoutError, KeyError, KeyboardInterrupt) as error:
        code = getattr(error, 'code', None)
        if isinstance(error, HTTPError):
            code = 'access_blocked' if error.code in (401, 403) else 'rate_limited' if error.code == 429 else 'http_error'
        elif isinstance(error, (URLError, TimeoutError)):
            code = 'connection_failed'
        elif isinstance(error, KeyboardInterrupt):
            code = 'interrupted'
        report['failures'].append({'code': code or 'extraction_failed', 'message': str(error), 'failedAt': now(),
                                   'sourceUrl': SOURCE, **report.get('activeSection', {})})
    report['finishedAt'] = now()
    atomic_json(run_dir / 'report.json', report)
    atomic_json(output.with_suffix('.report.json'), report)
    if report['complete']:
        print(f"Saved {report['sectionsExtracted']} sections to {output}; changes={report['changes']}")
        print(f'Capture: {capture_path}')
        return 0
    print(f"Extraction incomplete; prior snapshot preserved. Report: {output.with_suffix('.report.json')}", file=sys.stderr)
    for failure in report['failures']:
        print(f"{failure['code']}: {failure['message']}", file=sys.stderr)
    return 1


if __name__ == '__main__':
    raise SystemExit(main())

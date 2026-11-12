#!/usr/bin/env python3
"""Fetch the public Cal Poly catalog into an atomic, source-backed JSON snapshot.

Standard library only. No credentials, database writes, or student portal access.
"""
import argparse
from dataclasses import dataclass, field
from datetime import datetime, timezone
from hashlib import sha256
from html.parser import HTMLParser
import json
import os
from pathlib import Path
import re
import sys
import tempfile
import time
from urllib.error import HTTPError, URLError
from urllib.parse import urljoin, urlparse
from urllib.request import HTTPRedirectHandler, Request, build_opener
from urllib.robotparser import RobotFileParser

BASE_URL = 'https://catalog.calpoly.edu'
INDEX_URL = BASE_URL + '/courses/'
USER_AGENT = 'CampusEssentials/0.1 (public course catalog importer)'
ROOT = Path(__file__).resolve().parents[1]


class NoRedirects(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def fetch_url(request, timeout):
    # A catalog redirect must be reviewed rather than followed to another host/path.
    return build_opener(NoRedirects()).open(request, timeout=timeout)


def utc_now():
    return datetime.now(timezone.utc).isoformat().replace('+00:00', 'Z')


def normalize(text):
    return ' '.join(text.replace('\u200b', '').replace('\ufeff', '').split())


@dataclass
class Node:
    tag: str
    attrs: dict = field(default_factory=dict)
    children: list = field(default_factory=list)

    def walk(self):
        yield self
        for child in self.children:
            if isinstance(child, Node):
                yield from child.walk()

    def has_class(self, name):
        return name in self.attrs.get('class', '').split()

    def find_class(self, name):
        return next((node for node in self.walk() if node.has_class(name)), None)

    def text(self):
        if self.tag in ('script', 'style'):
            return ''
        if self.tag == 'br':
            return '\n'
        return ''.join(child.text() if isinstance(child, Node) else child for child in self.children)


class CatalogHTML(HTMLParser):
    VOID = {'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr'}

    def __init__(self, html):
        super().__init__(convert_charrefs=True)
        self.root = Node('document')
        self.stack = [self.root]
        self.feed(html)
        self.close()

    def handle_starttag(self, tag, attrs):
        node = Node(tag, dict(attrs))
        self.stack[-1].children.append(node)
        if tag not in self.VOID:
            self.stack.append(node)

    def handle_startendtag(self, tag, attrs):
        self.handle_starttag(tag, attrs)
        if tag not in self.VOID:
            self.handle_endtag(tag)

    def handle_endtag(self, tag):
        for i in range(len(self.stack) - 1, 0, -1):
            if self.stack[i].tag == tag:
                del self.stack[i:]
                break

    def handle_data(self, data):
        self.stack[-1].children.append(data)


def catalog_edition(root):
    editions = set()
    for node in root.walk():
        if node.has_class('edition'):
            match = re.search(r'(20\d{2})\s*[-–]\s*(20\d{2})\s+(?:Catalog|Edition)', normalize(node.text()))
            if match:
                editions.add('-'.join(match.groups()))
    if len(editions) != 1:
        raise ValueError('Missing or ambiguous catalog edition; page structure may have changed.')
    return editions.pop()


def discover_subjects(html, expected_edition, campus='slo'):
    root = CatalogHTML(html).root
    if catalog_edition(root) != expected_edition:
        raise ValueError(f'Catalog edition differs from requested {expected_edition}.')
    subjects = {}
    for node in root.walk():
        if node.tag != 'a':
            continue
        url = urljoin(INDEX_URL, node.attrs.get('href', ''))
        parsed = urlparse(url)
        match = re.fullmatch(r'/courses/([a-z]{2,5})/', parsed.path)
        if parsed.scheme != 'https' or parsed.netloc != 'catalog.calpoly.edu' or parsed.query or parsed.fragment or not match:
            continue
        subject = match.group(1).upper()
        label = normalize(node.text())
        # Navigation and main content repeat links; keep the descriptive campus label.
        if subject not in subjects or len(label) > len(subjects[subject]['label']):
            subjects[subject] = {'subject': subject, 'label': label, 'url': url,
                                 'campus': 'Solano' if 'Solano Campus' in label else 'San Luis Obispo'}
    if not subjects:
        raise ValueError('No subject links found; refusing an empty catalog.')
    return sorted((row for row in subjects.values() if campus == 'all' or row['campus'] == 'San Luis Obispo'), key=lambda row: row['subject'])


def class_text(node, class_name, required=False):
    found = node.find_class(class_name)
    text = normalize(found.text()) if found else ''
    if required and not text:
        raise ValueError(f'Missing {class_name}; page structure or course data needs review.')
    return text


def course_id(course):
    # Must match makeCourse in lambda/index.js so later API imports are idempotent.
    identity = [course['subject'], course['number'], course['catalogEdition'], '', '', '']
    return 'course:' + sha256(json.dumps(identity, ensure_ascii=False, separators=(',', ':')).encode()).hexdigest()


def parse_subject(html, subject, edition, source_url, retrieved_at, campus):
    root = CatalogHTML(html).root
    if catalog_edition(root) != edition:
        raise ValueError(f'{subject}: catalog edition does not match {edition}.')
    blocks = [node for node in root.walk() if node.has_class('courseblock')]
    if not blocks:
        raise ValueError(f'{subject}: no course blocks found; requires review before publishing.')
    courses = []
    for block in blocks:
        code = class_text(block, 'courseblockcode', required=True)
        match = re.fullmatch(r'([A-Z]{2,5})\s+(\d{3,4}[A-Z]?)', code)
        if not match or match.group(1) != subject:
            raise ValueError(f'{subject}: unexpected course code {code!r}.')
        hours = class_text(block, 'courseblock__hours', required=True)
        unit_match = re.fullmatch(r'\(?([\d.]+(?:\s*[-–]\s*[\d.]+)?)\s+units?\)?', hours, re.I)
        if not unit_match:
            raise ValueError(f'{code}: unrecognized unit value {hours!r}.')
        course = {
            'subject': subject, 'number': match.group(2),
            'title': class_text(block, 'courseblock__title', required=True),
            'description': class_text(block, 'courseblock__description', required=True),
            'units': unit_match.group(1).replace(' ', '').replace('–', '-'),
            'term': re.sub(r'^Term Typically Offered:\s*', '', class_text(block, 'detail-typically_offered')),
            'prerequisite': '', 'corequisite': '', 'concurrent': '', 'recommended': '',
            'geArea': class_text(block, 'detail-gearea'),
            'gradingBasis': class_text(block, 'detail-gradebasis'),
            # Preserve the complete detail text as evidence even for unfamiliar labels.
            'catalogDetails': class_text(block, 'courseblock__details'),
            'campus': campus, 'catalogEdition': edition,
            'sourceUrl': source_url, 'retrievedAt': retrieved_at,
        }
        requirements = class_text(block, 'detail-prereq')
        labels = list(re.finditer(r'\b(Prerequisite|Corequisite|Concurrent|Recommended):\s*', requirements, re.I))
        for i, label in enumerate(labels):
            value = requirements[label.end():labels[i + 1].start() if i + 1 < len(labels) else len(requirements)].strip()
            field_name = label.group(1).lower()
            course[field_name] = normalize(course[field_name] + ' ' + value)
        course['id'] = course_id(course)
        courses.append(course)
    if len({course['id'] for course in courses}) != len(courses):
        raise ValueError(f'{subject}: duplicate course IDs found.')
    return courses


def atomic_json(path, value):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary = tempfile.mkstemp(prefix='.' + path.name, dir=path.parent)
    try:
        with os.fdopen(fd, 'w', encoding='utf-8') as output:
            json.dump(value, output, ensure_ascii=False, indent=2, allow_nan=False)
            output.write('\n')
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


class CatalogFetcher:
    def __init__(self, cache_dir, offline=False, refresh=False, delay=1.0):
        self.cache_dir = Path(cache_dir)
        self.offline = offline
        self.refresh = refresh
        self.delay = delay
        self.last_request = 0
        self.robots = None

    def fetch(self, url):
        parsed = urlparse(url)
        if parsed.scheme != 'https' or parsed.netloc != 'catalog.calpoly.edu':
            raise ValueError('Only the official HTTPS catalog host may be fetched.')
        if parsed.path != '/robots.txt':
            if self.robots is None:
                rules = self.fetch(BASE_URL + '/robots.txt')
                self.robots = RobotFileParser()
                self.robots.parse(rules['html'].splitlines())
                self.delay = max(self.delay, self.robots.crawl_delay(USER_AGENT) or 0)
            if not self.robots.can_fetch(USER_AGENT, url):
                raise ValueError(f'robots.txt disallows {url}')
        cache_path = self.cache_dir / (sha256(url.encode()).hexdigest() + '.json')
        if cache_path.exists():
            cached = json.loads(cache_path.read_text(encoding='utf-8'))
            if cached.get('url') != url or cached.get('sha256') != sha256(cached['html'].encode()).hexdigest():
                raise ValueError(f'Corrupt cache for {url}; remove it and refresh.')
            age = time.time() - datetime.fromisoformat(cached['retrievedAt'].replace('Z', '+00:00')).timestamp()
            if self.offline or (not self.refresh and age < 86400):
                return cached
        if self.offline:
            raise ValueError(f'No cached page for {url}; run online first.')
        for attempt in range(3):
            time.sleep(max(0, self.delay - (time.monotonic() - self.last_request)))
            self.last_request = time.monotonic()
            try:
                request = Request(url, headers={'User-Agent': USER_AGENT, 'Accept': 'text/html,text/plain'})
                with fetch_url(request, timeout=20) as response:
                    if response.url != url:
                        raise ValueError(f'Unexpected redirect from {url} to {response.url}')
                    raw = response.read(5_000_001)
                    if len(raw) > 5_000_000:
                        raise ValueError(f'Oversized response for {url}')
                    html = raw.decode('utf-8-sig')
                record = {'url': url, 'retrievedAt': utc_now(), 'sha256': sha256(html.encode()).hexdigest(), 'html': html}
                atomic_json(cache_path, record)
                return record
            except HTTPError as error:
                if error.code not in (429, 500, 502, 503, 504) or attempt == 2:
                    raise
                retry_after = error.headers.get('Retry-After', '')
                time.sleep(min(30, float(retry_after)) if retry_after.isdigit() else 2 ** attempt)
            except (URLError, TimeoutError):
                if attempt == 2:
                    raise
                time.sleep(2 ** attempt)
        raise RuntimeError('Fetch retries exhausted')


def build_catalog(fetcher, edition, campus='slo', requested_subjects=None):
    index = fetcher.fetch(INDEX_URL)
    available = discover_subjects(index['html'], edition, campus)
    requested_subjects = set(requested_subjects or [])
    unknown = requested_subjects - {row['subject'] for row in available}
    if unknown:
        raise ValueError('Subjects absent from selected campus scope: ' + ', '.join(sorted(unknown)))
    selected = [row for row in available if not requested_subjects or row['subject'] in requested_subjects]
    courses, sources, failures = [], [], []
    for position, row in enumerate(selected, 1):
        try:
            page = fetcher.fetch(row['url'])
            parsed = parse_subject(page['html'], row['subject'], edition, row['url'], page['retrievedAt'], row['campus'])
            courses.extend(parsed)
            sources.append({**row, 'courseCount': len(parsed), 'retrievedAt': page['retrievedAt'], 'sha256': page['sha256']})
            print(f"[{position}/{len(selected)}] {row['subject']}: {len(parsed)} courses", file=sys.stderr, flush=True)
        except (ValueError, OSError) as error:
            failures.append({'subject': row['subject'], 'url': row['url'], 'error': str(error)})
            print(f"[{position}/{len(selected)}] {row['subject']}: FAILED ({error})", file=sys.stderr, flush=True)
    ids = [course['id'] for course in courses]
    if len(ids) != len(set(ids)):
        failures.append({'error': 'Duplicate course IDs across subject pages.'})
    report = {
        'schemaVersion': 1, 'catalogEdition': edition, 'campusScope': campus,
        'sourceUrl': INDEX_URL, 'generatedAt': utc_now(),
        'indexRetrievedAt': index['retrievedAt'], 'indexSha256': index['sha256'],
        'offline': fetcher.offline, 'complete': not failures,
        'scope': 'selected-subjects' if requested_subjects else 'all-subjects',
        'subjectsAvailable': len(available), 'subjectsRequested': len(selected),
        'subjectsImported': len(sources), 'courseCount': len(courses),
        'sources': sources, 'failures': failures,
        'qualityNotes': {'coursesWithoutTypicalTerm': [f"{course['subject']} {course['number']}" for course in courses if not course['term']]},
    }
    return report, sorted(courses, key=lambda course: (course['subject'], course['number']))


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--edition', default='2026-2028')
    parser.add_argument('--campus', choices=['slo', 'all'], default='slo', help='Exclude subjects explicitly labeled Solano by default.')
    parser.add_argument('--subject', action='append', help='Repeat for a pilot import, e.g. --subject AERO.')
    parser.add_argument('--output', type=Path, help='Snapshot destination (required for a subject-only pilot).')
    parser.add_argument('--cache-dir', type=Path, default=ROOT / 'data/catalog/.cache')
    parser.add_argument('--offline', action='store_true', help='Use saved pages without network access.')
    parser.add_argument('--refresh', action='store_true', help='Refetch pages instead of reusing a cache less than 24 hours old.')
    args = parser.parse_args(argv)
    if not re.fullmatch(r'20\d{2}-20\d{2}', args.edition):
        parser.error('edition must be YYYY-YYYY')
    if args.offline and args.refresh:
        parser.error('--offline and --refresh cannot be combined')
    if args.subject and not args.output:
        parser.error('--subject requires --output so a pilot cannot replace the default full snapshot')
    output = args.output or ROOT / f'data/catalog/{args.edition}{"-all" if args.campus == "all" else ""}.json'
    fetcher = CatalogFetcher(args.cache_dir, args.offline, args.refresh)
    try:
        report, courses = build_catalog(fetcher, args.edition, args.campus, [value.upper() for value in args.subject or []])
        if not report['complete']:
            atomic_json(output.with_suffix('.report.json'), report)
            print('Import incomplete. Previous course snapshot left untouched; see the report.', file=sys.stderr)
            return 1
        snapshot = {**report, 'courses': courses}
        atomic_json(output, snapshot)
        atomic_json(output.with_suffix('.report.json'), report)
        print(f"Saved {len(courses)} courses from {report['subjectsImported']} subjects to {output}")
        return 0
    except (ValueError, OSError) as error:
        print(f'Import failed: {error}. Previous snapshot left untouched.', file=sys.stderr)
        return 1


if __name__ == '__main__':
    raise SystemExit(main())

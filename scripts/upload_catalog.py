#!/usr/bin/env python3
"""Validate a catalog snapshot and optionally upload it to the existing course API.

Dry-run by default. --apply requires API_BASE_URL and ADMIN_PASSWORD in the
process environment. Never reads credentials from the snapshot or follows redirects.
"""
import argparse
import json
import os
from pathlib import Path
import sys
import time
from urllib.error import HTTPError, URLError
from urllib.parse import urlparse
from urllib.request import HTTPRedirectHandler, Request, build_opener

try:
    from .import_catalog import course_id
except ImportError:
    from import_catalog import course_id


class NoRedirects(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def validate_snapshot(snapshot):
    if not isinstance(snapshot, dict) or snapshot.get('schemaVersion') != 1 or snapshot.get('complete') is not True:
        raise ValueError('Expected a complete version-1 catalog snapshot.')
    courses = snapshot.get('courses')
    if not isinstance(courses, list) or not courses or len(courses) != snapshot.get('courseCount'):
        raise ValueError('Snapshot course count is invalid.')
    ids = set()
    for course in courses:
        if not isinstance(course, dict):
            raise ValueError('Each course must be an object.')
        for key in ('id', 'subject', 'number', 'title', 'description', 'units', 'catalogEdition', 'sourceUrl', 'retrievedAt'):
            if not isinstance(course.get(key), str) or not course[key].strip():
                raise ValueError(f'Course is missing {key}.')
        if course['catalogEdition'] != snapshot.get('catalogEdition') or course['id'] != course_id(course):
            raise ValueError('Course edition or stable ID does not match the snapshot.')
        if course['id'] in ids:
            raise ValueError('Snapshot contains duplicate IDs.')
        ids.add(course['id'])
    return courses


def upload_courses(courses, api_base_url, password, send=None, sleep=time.sleep):
    parsed = urlparse(api_base_url)
    if parsed.scheme != 'https' or not parsed.netloc or parsed.username or parsed.password or parsed.query or parsed.fragment:
        raise ValueError('API_BASE_URL must be an HTTPS base URL without credentials, query or fragment.')
    if not password:
        raise ValueError('ADMIN_PASSWORD is required for --apply.')
    send = send or build_opener(NoRedirects()).open
    endpoint = api_base_url.rstrip('/') + '/courses/bulk'
    uploaded = 0
    for start in range(0, len(courses), 25):
        batch = courses[start:start + 25]
        body = json.dumps({'courses': batch}, ensure_ascii=False).encode('utf-8')
        for attempt in range(3):
            request = Request(endpoint, data=body, method='POST', headers={
                'Content-Type': 'application/json', 'Authorization': 'Bearer ' + password,
            })
            try:
                with send(request, timeout=35) as response:
                    result = json.loads(response.read(1_000_000))
                    if response.status != 201 or not isinstance(result, dict) or result.get('count') != len(batch):
                        raise ValueError('API did not acknowledge the complete batch.')
                uploaded += len(batch)
                print(f'Uploaded {uploaded}/{len(courses)} courses', flush=True)
                break
            except HTTPError as error:
                # Do not print response bodies or request headers (which may contain credentials).
                if error.code not in (429, 500, 502, 503, 504) or attempt == 2:
                    raise ValueError(f'Upload stopped at batch starting with row {start + 1}: HTTP {error.code}. Earlier rows may be saved; retry the same snapshot.') from None
                sleep(2 ** attempt)
            except (URLError, TimeoutError):
                if attempt == 2:
                    raise ValueError(f'Upload interrupted at row {start + 1}; retry the same snapshot. Some rows may already be saved.') from None
                sleep(2 ** attempt)
    return uploaded


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('snapshot', type=Path)
    parser.add_argument('--apply', action='store_true', help='Write to the API configured in API_BASE_URL; otherwise validate only.')
    args = parser.parse_args(argv)
    try:
        snapshot = json.loads(args.snapshot.read_text(encoding='utf-8'))
        courses = validate_snapshot(snapshot)
        if not args.apply:
            print(f'Dry run: {len(courses)} valid courses, {(len(courses) + 24) // 25} batches. No API requests made.')
            return 0
        upload_courses(courses, os.environ.get('API_BASE_URL', ''), os.environ.get('ADMIN_PASSWORD', ''))
        return 0
    except (ValueError, OSError) as error:
        print(f'Upload failed: {error}', file=sys.stderr)
        return 1


if __name__ == '__main__':
    raise SystemExit(main())

#!/usr/bin/env python3
"""Expand schedule coverage in resumable batches using the existing validated pipeline."""
import argparse
from datetime import datetime, timezone
from pathlib import Path
import re
import sys
import time
from urllib.error import HTTPError, URLError
from uuid import uuid4

try:
    from . import extract_sections as e, sync_sections as p
except ImportError:
    import extract_sections as e
    import sync_sections as p


def scope(config, subject):
    return {'institution': 'SLCMP', 'termId': config['term'], 'campus': config['campus'],
            'subject': subject, 'courseNumber': None, 'includeClosed': True}


def new_queue(config, catalog, subjects):
    campus = {'MAIN': 'San Luis Obispo', 'SOLA': 'Solano'}.get(config['campus'])
    p.check(campus, 'Explicit catalog campus mapping required')
    known = {c['subject'] for c in catalog['courses'] if c['campus'] == campus}
    offered = {s['subject'] for s in subjects}
    return {'schemaVersion': 1, 'term': config['term'], 'campus': config['campus'],
            'catalogEdition': catalog['catalogEdition'], 'sourceUrl': e.SOURCE,
            'discoveredAt': e.now(), 'updatedAt': e.now(),
            'unmappedSubjects': [s for s in subjects if s['subject'] not in known],
            'catalogSubjectsNotInSearch': sorted(known - offered),
            'jobs': [{**s, 'status': 'pending'} for s in sorted(subjects, key=lambda s: s['subject'])
                     if s['subject'] in known and re.fullmatch(r'[A-Z]{2,5}', s['subject'])]}


def discover(config):
    session = e.Session(config['delaySeconds'])
    # BIO is the existing configured pilot; start verifies the public institution form.
    session.start(scope(config, config['jobs'][0]['subject']))
    select = e.by_id(session.root, e.SUBJECT)
    e.require(select is not None, 'Subject selector missing')
    return [{'subject': n.attrs['value'], 'label': e.normalize(n.text())}
            for n in select.walk() if n.tag == 'option' and n.attrs.get('value', '').strip()]


def probe(config, subject, directory):
    query = scope(config, subject)
    client = e.Capture(e.Session(config['delaySeconds']), directory / 'capture.json', query)
    metadata = client.start(query)
    root, _ = client.step(e.SEARCH, e.search_updates(query))
    if 'Your search will return over 50 classes, would you like to continue?' in e.normalize(root.text()):
        root, _ = client.step('#ICSave')
    if 'maximum limit of 300 sections' in e.normalize(root.text()):
        raise e.ExtractionError('result_limit', 'Official search exceeds 300 sections; partitioned extraction is required')
    rows, term = e.parse_results(root, query, metadata)
    client.finish()
    result = {'sourceUrl': e.SOURCE, 'retrievedAt': e.now(), 'termLabel': term,
              'sectionsDiscovered': len(rows), 'pilotCourse': rows[0]['number'] if rows else None,
              'capturePath': e.display_path(client.path)}
    e.atomic_json(directory / 'probe.json', result)
    return result


def select_jobs(state, size, subjects=None, retry_failed=False, refresh=False):
    if subjects:
        p.check(set(subjects) <= {j['subject'] for j in state['jobs']}, 'Subject is not in the mapped discovery queue')
    statuses = {'failed'} if retry_failed else {'pending', 'running'}
    if refresh:
        statuses |= {'complete', 'no_sections'}
    return [j for j in state['jobs'] if j['status'] in statuses
            and (not subjects or j['subject'] in subjects)][:size]


def summarize(state):
    return {status: sum(j['status'] == status for j in state['jobs'])
            for status in ('pending', 'running', 'complete', 'no_sections', 'failed')}


def run(config, state, selected, destination, probe_fn=probe, pipeline_fn=p.run_pipeline):
    run_id = datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%S') + '-' + uuid4().hex[:8]
    root = p.resolve(config['outputDir']) / '.runs/expansion' / run_id
    failed = False
    for job in selected:
        job.update(status='running', startedAt=e.now())
        job.pop('error', None)
        job.pop('pipelineReport', None)
        e.atomic_json(destination, state)
        directory = root / job['subject']
        directory.mkdir(parents=True)
        try:
            for attempt in range(config['connectionRetries'] + 1):
                try:
                    result = probe_fn(config, job['subject'], directory / str(attempt + 1))
                    break
                except (URLError, TimeoutError) as error:
                    if isinstance(error, HTTPError) or attempt == config['connectionRetries']:
                        raise
                    time.sleep(config['retryDelaySeconds'])
            job['discovery'] = result
            if not result['sectionsDiscovered']:
                job['status'] = 'no_sections'
            else:
                pipeline_config = {**config, 'jobs': [{'subject': job['subject'],
                    'pilotCourse': result['pilotCourse'], 'minimumSections': 1}]}
                code = pipeline_fn(pipeline_config)
                report = p.read_json(p.resolve(config['outputDir']) / 'pipeline.report.json')
                job['pipelineReport'] = e.display_path(p.resolve(config['outputDir']) / '.runs/pipeline' / report['runId'] / 'report.json')
                if code or report['status'] != 'complete':
                    raise ValueError('; '.join(f['message'] for f in report['failures']) or 'Pipeline failed')
                job.update(status='complete', summary=report['jobs'][0]['summary'],
                           databaseImport=report['jobs'][0].get('databaseImport'))
        except (ValueError, OSError, TimeoutError, KeyboardInterrupt) as error:
            failed = True
            job.update(status='failed', error={'code': getattr(error, 'code', 'expansion_failed'),
                                              'message': str(error) or 'Interrupted'})
            if isinstance(error, KeyboardInterrupt):
                break
        finally:
            job['finishedAt'] = state['updatedAt'] = e.now()
            e.atomic_json(directory / 'result.json', job)
            e.atomic_json(destination, state)
            print(f"{job['subject']}: {job['status']}", flush=True)
        if job.get('error', {}).get('code') in ('access_blocked', 'rate_limited', 'robots_disallowed', 'login_required', 401, 403, 429):
            break
    print(summarize(state), flush=True)
    return 1 if failed else 0


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--config', type=Path, default=p.DEFAULT_CONFIG)
    parser.add_argument('--batch-size', type=int, default=3)
    parser.add_argument('--subjects', nargs='+')
    parser.add_argument('--retry-failed', action='store_true')
    parser.add_argument('--refresh', action='store_true', help='Allow refreshing completed subjects in the selected batch')
    parser.add_argument('--status', action='store_true')
    args = parser.parse_args(argv)
    try:
        config = p.load_config(p.resolve(args.config))
        p.check(1 <= args.batch_size <= 100, 'batch-size must be 1–100')
        p.check(config.get('databaseImport', {}).get('enabled'), 'Expansion requires database import enabled')
        catalog = p.read_json(p.resolve(config['databaseImport']['catalogPath']))
        output = p.resolve(config['outputDir'])
        destination = output / 'expansion.report.json'
        with p.output_lock(output / '.expansion'):
            if destination.exists():
                state = p.read_json(destination)
                p.check(state['term'] == config['term'] and state['campus'] == config['campus']
                        and state['catalogEdition'] == catalog['catalogEdition'], 'Queue scope changed; use a separate outputDir')
            else:
                p.check(not args.status, 'No expansion queue yet')
                state = new_queue(config, catalog, discover(config))
                e.atomic_json(destination, state)
            if args.status:
                print(summarize(state))
                for job in state['jobs']:
                    if job['status'] == 'failed':
                        print(job['subject'], job['error'])
                return 0
            selected = select_jobs(state, args.batch_size, args.subjects, args.retry_failed, args.refresh)
            return run(config, state, selected, destination)
    except (ValueError, OSError, KeyError) as error:
        print(f'Expansion failed: {error}', file=sys.stderr)
        return 1


if __name__ == '__main__':
    raise SystemExit(main())

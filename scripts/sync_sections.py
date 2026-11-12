#!/usr/bin/env python3
"""Configuration-driven section discovery pipeline. Python only; no Codex runtime.

Preflight -> extract to staging -> replay -> quality gate -> atomic publication.
Run once from a shell or an external job runner; this script installs no schedule.
"""
import argparse
from contextlib import contextmanager, redirect_stderr, redirect_stdout
from datetime import datetime, timezone
import fcntl
import json
import math
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import time
from uuid import uuid4

try:
    from . import extract_sections as extractor
except ImportError:
    import extract_sections as extractor

ROOT = extractor.ROOT
DEFAULT_CONFIG = ROOT / 'config/sections-pipeline.json'


def read_json(path):
    return json.loads(Path(path).read_text(encoding='utf-8'))


def resolve(path):
    path = Path(path)
    return path if path.is_absolute() else ROOT / path


def check(condition, message):
    if not condition:
        raise ValueError(message)


def load_config(path):
    config = read_json(path)
    check(config.get('schemaVersion') == 1, 'Configuration requires schemaVersion 1')
    check(isinstance(config.get('term'), str) and re.fullmatch(r'\d{4}', config['term']), 'Invalid term')
    check(config.get('campus') in ('MAIN', 'AHC', 'CCC', 'SOLA'), 'Invalid campus')
    check(isinstance(config.get('outputDir'), str) and config['outputDir'].strip(), 'outputDir is required')
    for key, low, high in [('delaySeconds', 1, 60), ('retryDelaySeconds', 1, 60),
                           ('staleAfterHours', 1, 8760), ('maxRemovalFraction', 0, 1)]:
        value = config.get(key)
        check(type(value) in (int, float) and math.isfinite(value) and low <= value <= high,
              f'{key} must be between {low} and {high}')
    check(type(config.get('connectionRetries')) is int and 0 <= config['connectionRetries'] <= 2,
          'connectionRetries must be 0, 1 or 2')
    database = config.get('databaseImport', {'enabled': False})
    check(isinstance(database, dict) and type(database.get('enabled')) is bool, 'databaseImport.enabled must be boolean')
    if database['enabled']:
        check(type(database.get('port')) is int and 1024 <= database['port'] <= 65535, 'Invalid local database port')
        check(isinstance(database.get('tableName'), str) and re.fullmatch(r'campus-essentials-local(?:-[a-zA-Z0-9-]+)?', database['tableName']), 'Only local database tables are allowed')
        check(isinstance(database.get('catalogPath'), str) and database['catalogPath'], 'databaseImport.catalogPath is required')
    jobs = config.get('jobs')
    check(isinstance(jobs, list) and 0 < len(jobs) <= 100, 'jobs must contain 1–100 subjects')
    seen = set()
    for job in jobs:
        check(isinstance(job, dict), 'Each job must be an object')
        check(isinstance(job.get('subject'), str) and re.fullmatch(r'[A-Z]{2,5}', job['subject']), 'Invalid subject')
        check(isinstance(job.get('pilotCourse'), str) and re.fullmatch(r'\d{3,4}[A-Z]?', job['pilotCourse']), 'pilotCourse is required')
        check(type(job.get('minimumSections')) is int and job['minimumSections'] > 0, 'minimumSections must be positive')
        check(job['subject'] not in seen, 'Duplicate subject job')
        seen.add(job['subject'])
    return config


@contextmanager
def output_lock(directory):
    """Kernel lock released even if killed; never delete a lock file held by another run."""
    directory.mkdir(parents=True, exist_ok=True)
    with (directory / '.pipeline.lock').open('a+') as handle:
        os.chmod(handle.name, 0o600)
        try:
            fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as error:
            raise BlockingIOError('Another pipeline owns this output directory') from error
        try:
            handle.seek(0)
            handle.truncate()
            handle.write(str(os.getpid()))
            handle.flush()
            yield
        finally:
            fcntl.flock(handle, fcntl.LOCK_UN)


def quality_gate(candidate, replay, prior, job, config):
    check(candidate['complete'] and replay['complete'], 'Incomplete extraction or replay')
    records = candidate['sections']
    check(candidate['sectionCount'] == len(records) >= job['minimumSections'], 'Section count below configured minimum')
    ids = {r['id'] for r in records}
    check(len(ids) == len(records), 'Duplicate section identities')
    check(candidate['contentSha256'] == extractor.content_hash(records), 'Candidate content checksum mismatch')
    check(replay['contentSha256'] == extractor.content_hash(replay['sections']) == candidate['contentSha256'],
          'Offline replay differs from extracted content')
    scope = {'institution': 'SLCMP', 'termId': config['term'], 'campus': config['campus'],
             'subject': job['subject'], 'courseNumber': None, 'includeClosed': True}
    check(candidate['scope'] == replay['scope'] == scope, 'Unexpected subject/term/campus scope')
    removed = set()
    if prior:
        check(prior['scope'] == scope, 'Previous snapshot has a different scope')
        old_ids = {r['id'] for r in prior['sections']}
        removed = old_ids - ids
        check(not old_ids or len(removed) / len(old_ids) <= config['maxRemovalFraction'],
              f'{len(removed)} of {len(old_ids)} existing sections disappeared; exceeds maxRemovalFraction')
    return {'sections': len(records), 'courses': candidate['courseCount'], 'removed': len(removed),
            'materialsLinks': sum(r['materialsLinkStatus'] == 'available' for r in records),
            'materialsNotListed': sum(r['materialsLinkStatus'] == 'not_listed' for r in records),
            'contentSha256': candidate['contentSha256'], 'replayMatches': True}


def import_database(snapshot, settings, report_path):
    command = ['node', str(ROOT / 'scripts/import-sections.cjs'), '--snapshot', str(snapshot.resolve()),
               '--catalog', str(resolve(settings['catalogPath'])), '--port', str(settings['port']),
               '--table', settings['tableName'], '--report', str(report_path.resolve())]
    with report_path.with_suffix('.log').open('w', encoding='utf-8') as handle:
        completed = subprocess.run(command, cwd=ROOT, stdout=handle, stderr=handle, check=False)
    check(report_path.exists(), f'Database importer produced no report; see {report_path.with_suffix(".log")}')
    report = read_json(report_path)
    check(completed.returncode == 0 and report.get('complete'),
          f'Database import incomplete; snapshot retained. Retry with npm run sections:import. See {report_path}')
    return {k: report[k] for k in ('complete', 'total', 'created', 'updated', 'unchanged', 'protected')}


def run_pipeline(config, replay_captures=None, execute=None, sleep=time.sleep):
    execute = execute or extractor.main
    output = resolve(config['outputDir'])
    with output_lock(output):
        run_id = datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%S') + '-' + uuid4().hex[:8]
        directory = output / '.runs/pipeline' / run_id
        directory.mkdir(parents=True)
        report = {'schemaVersion': 1, 'runId': run_id, 'mode': 'replay' if replay_captures else 'live',
                  'status': 'running', 'startedAt': extractor.now(), 'finishedAt': None,
                  'config': config, 'jobs': [], 'failures': []}

        def save():
            extractor.atomic_json(directory / 'report.json', report)
            extractor.atomic_json(output / 'pipeline.report.json', report)

        def stage(entry, name, course=None, capture=None, prior_path=None):
            entry['stage'] = name
            save()
            print(f"{entry['subject']}: {name}", flush=True)
            for attempt in range(config['connectionRetries'] + 1):
                target = directory / entry['subject'] / f'{name}-{attempt + 1}.json'
                target.parent.mkdir(parents=True, exist_ok=True)
                if prior_path and prior_path.exists():
                    shutil.copyfile(prior_path, target)
                args = ['--term', config['term'], '--campus', config['campus'], '--subject', entry['subject'],
                        '--delay', str(config['delaySeconds']), '--output', str(target)]
                if course:
                    args += ['--course', course]
                if capture:
                    args += ['--replay', str(resolve(capture))]
                log = target.with_suffix('.log')
                with log.open('w', encoding='utf-8') as handle, redirect_stdout(handle), redirect_stderr(handle):
                    code = execute(args)
                stage_report = read_json(target.with_suffix('.report.json'))
                entry['attempts'].append({'stage': name, 'attempt': attempt + 1, 'exitCode': code,
                                          'report': extractor.display_path(target.with_suffix('.report.json')),
                                          'log': extractor.display_path(log)})
                save()
                if code == 0 and stage_report.get('complete'):
                    return target, stage_report
                failures = stage_report.get('failures', [])
                if any(f['code'] == 'interrupted' for f in failures):
                    raise KeyboardInterrupt
                # Only connection faults retry, always with a fresh session. No retries for
                # bot challenges, 429s, schema changes, failed gates or wrong scope.
                retry = not capture and failures and all(f['code'] == 'connection_failed' for f in failures)
                if not retry or attempt == config['connectionRetries']:
                    raise ValueError(f"{name} failed: " + '; '.join(f.get('message', f['code']) for f in failures))
                sleep(config['retryDelaySeconds'])
            raise AssertionError('unreachable')

        save()
        for job in config['jobs']:
            entry = {'subject': job['subject'], 'status': 'running', 'stage': 'preflight', 'attempts': [], 'published': False}
            report['jobs'].append(entry)
            name = f"{config['term']}-{config['campus']}-{job['subject']}"
            published = output / (name + '.json')
            try:
                prior = read_json(published) if published.exists() else None
                captures = replay_captures[job['subject']] if replay_captures else {}
                if replay_captures:
                    check(prior is None or prior.get('mode') == 'replay', 'Offline pipeline cannot replace live data; use another outputDir')
                if prior:
                    (directory / job['subject']).mkdir(parents=True, exist_ok=True)
                    shutil.copyfile(published, directory / job['subject'] / 'previous.json')
                pilot, _ = stage(entry, 'preflight', job['pilotCourse'], captures.get('pilot'))
                check(read_json(pilot)['sectionCount'] > 0, 'Pilot has no sections; check term/pilotCourse before expansion')
                candidate_path, extraction_report = stage(entry, 'extract', capture=captures.get('subject'), prior_path=published)
                replay_path, _ = stage(entry, 'verify-replay', capture=extraction_report['capturePath'])
                candidate = read_json(candidate_path)
                entry['stage'] = 'quality-gate'
                save()
                entry['summary'] = quality_gate(candidate, read_json(replay_path), prior, job, config)
                entry['changes'] = extraction_report['changes']
                entry['stage'] = 'publish'
                save()
                # The staged report/capture is durable before the atomic per-subject replacement.
                extractor.atomic_json(published, candidate)
                entry['published'] = True
                extractor.atomic_json(published.with_suffix('.report.json'), extraction_report)
                settings = config.get('databaseImport', {'enabled': False})
                if settings['enabled'] and not replay_captures:
                    entry['stage'] = 'database-import'
                    import_report = directory / job['subject'] / 'database-import.report.json'
                    entry['databaseReport'] = extractor.display_path(import_report)
                    save()
                    entry['databaseImport'] = import_database(published, settings, import_report)
                else:
                    entry['databaseImport'] = {'skipped': 'offline-replay' if replay_captures else 'disabled'}
                entry.update(status='complete', stage='complete', snapshot=extractor.display_path(published))
            except (ValueError, OSError, KeyError, KeyboardInterrupt) as error:
                entry['status'] = 'failed'
                failure = {'subject': job['subject'], 'stage': entry['stage'], 'message': str(error) or 'Interrupted',
                           'failedAt': extractor.now(), 'published': entry['published']}
                report['failures'].append(failure)
                print(f"{job['subject']}: FAILED at {entry['stage']}: {failure['message']}", file=sys.stderr)
                if isinstance(error, KeyboardInterrupt):
                    break
            finally:
                save()
        report.update(status='failed' if report['failures'] else 'complete', finishedAt=extractor.now())
        save()
        print(f"Pipeline {report['status']}: {output / 'pipeline.report.json'}")
        return 0 if report['status'] == 'complete' else 1


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--config', type=Path, default=DEFAULT_CONFIG)
    parser.add_argument('--plan', action='store_true', help='Validate config and show scope without network or writes')
    parser.add_argument('--status', action='store_true', help='Print latest status; nonzero if missing, failed, running or stale')
    parser.add_argument('--replay-captures', type=Path, help='Offline acceptance: JSON mapping subject to pilot/subject capture paths')
    args = parser.parse_args(argv)
    try:
        config = load_config(resolve(args.config))
        if args.plan:
            stages = ['preflight', 'extract', 'verify-replay', 'quality-gate', 'publish']
            if config.get('databaseImport', {}).get('enabled'):
                stages.append('database-import')
            print(json.dumps({'config': config, 'stages': stages}, indent=2))
            return 0
        if args.status:
            report = read_json(resolve(config['outputDir']) / 'pipeline.report.json')
            matches = report.get('config') == config
            stamp = report.get('finishedAt')
            age = (datetime.now(timezone.utc) - datetime.fromisoformat(stamp.replace('Z', '+00:00'))).total_seconds() / 3600 if stamp else None
            healthy = matches and report.get('mode') == 'live' and report['status'] == 'complete' and age is not None and 0 <= age <= config['staleAfterHours']
            print(json.dumps({**report, 'configMatches': matches, 'ageHours': age, 'healthy': healthy}, indent=2))
            return 0 if healthy else 1
        captures = read_json(resolve(args.replay_captures)) if args.replay_captures else None
        if captures is not None:
            for job in config['jobs']:
                check(isinstance(captures.get(job['subject']), dict) and all(captures[job['subject']].get(k) for k in ('pilot', 'subject')),
                      'Offline mode requires both pilot and subject captures for every job')
        return run_pipeline(config, captures)
    except BlockingIOError as error:
        print(str(error), file=sys.stderr)
        return 2
    except (ValueError, OSError, KeyError, TypeError) as error:
        print(f'Pipeline error: {error}', file=sys.stderr)
        return 1


if __name__ == '__main__':
    raise SystemExit(main())

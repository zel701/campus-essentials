// Local-only, repeatable bridge from validated discovery snapshots to section records.
const fs = require('node:fs');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { createAcademicApi } = require('../lambda/academic-records');
const { localClients } = require('./local-api.cjs');
const root = path.resolve(__dirname, '..');
const sourceUrl = 'https://cmsweb.pscs.calpoly.edu/psc/CSLOPRD/EMPLOYEE/SA/c/COMMUNITY_ACCESS.CLASS_SEARCH.GBL';
const campuses = { MAIN: 'San Luis Obispo', SOLA: 'Solano' };
const read = p => JSON.parse(fs.readFileSync(p, 'utf8'));
const check = (value, message) => { if (!value) throw new Error(message); };
const hash = value => createHash('sha256').update(value).digest('hex');
const stable = value => Array.isArray(value) ? value.map(stable) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])])) : value;
function contentHash(rows) {
  return hash(JSON.stringify(stable(rows.map(row => Object.fromEntries(Object.entries(row)
    .filter(([key]) => !['source', 'firstSeenAt', 'updatedAt', 'lastSeenAt'].includes(key)))))));
}
function atomicJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = file + '.' + randomUUID() + '.tmp';
  try {
    fs.writeFileSync(temporary, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
    fs.renameSync(temporary, file);
  } finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
}
class HttpError extends Error { constructor(statusCode, message) { super(message); this.statusCode = statusCode; } }
function api(dynamo, tableName) {
  return createAcademicApi({ dynamo, tableName: () => tableName, HttpError,
    isAdmin: () => false, readBody: () => { throw new Error('No HTTP import'); }, headers: {} });
}
function validateTarget(port, tableName) {
  check(Number.isInteger(port) && port >= 1024 && port <= 65535, 'Invalid local DynamoDB port');
  check(/^campus-essentials-local(?:-[a-zA-Z0-9-]+)?$/.test(tableName), 'Only local table names are accepted');
}

function plan(snapshot, catalog, academic) {
  check(snapshot.schemaVersion === 1 && snapshot.complete === true && snapshot.mode === 'live', 'Only complete live snapshots may be imported');
  check(snapshot.sourceUrl === sourceUrl && snapshot.scope?.institution === 'SLCMP' && snapshot.scope.includeClosed === true, 'Unexpected snapshot source or scope');
  check(/^\d{4}$/.test(snapshot.scope.termId) && /^[A-Z]{2,5}$/.test(snapshot.scope.subject), 'Invalid snapshot term/subject');
  const campus = campuses[snapshot.scope.campus];
  check(campus, 'No catalog campus mapping for this snapshot; explicit mapping is required');
  check(Array.isArray(snapshot.sections) && snapshot.sections.length > 0 && snapshot.sectionCount === snapshot.sections.length, 'Empty or incomplete section snapshot');
  check(contentHash(snapshot.sections) === snapshot.contentSha256, 'Section content checksum mismatch');
  check(catalog.complete === true && Array.isArray(catalog.courses) && catalog.courseCount === catalog.courses.length, 'Incomplete catalog');
  const seen = new Set();
  const ids = new Set();
  return snapshot.sections.map(row => {
    check(row.subject === snapshot.scope.subject && row.termId === snapshot.scope.termId && row.campus === snapshot.scope.campus,
      'Section differs from snapshot scope');
    check(!snapshot.scope.courseNumber || snapshot.scope.courseNumber === row.number, 'Section differs from course scope');
    check(/^\d+$/.test(row.crn) && typeof row.sectionNumber === 'string', 'Invalid section identity');
    check(row.id === 'scheduleSection:' + hash(JSON.stringify(['SLCMP', row.termId, row.campus, row.crn])), 'Discovery ID mismatch');
    check(!seen.has(row.id), 'Duplicate discovery section'); seen.add(row.id);
    check(row.source?.sourceUrl === sourceUrl && /^[a-f0-9]{64}$/.test(row.source.sha256), 'Missing source evidence');
    check(row.materialsVerificationStatus === 'not_checked', 'Unexpected textbook verification claim');
    check(['available', 'not_listed'].includes(row.materialsLinkStatus), 'Unknown materials link status');
    if (row.materialsLinkStatus === 'available') {
      const url = new URL(row.materialsUrl);
      const parameters = [...url.searchParams].sort();
      const expected = [['bookstore_id-1', '2020'], ['crn-1', row.crn], ['term_id-1', row.termId]].sort();
      check(url.origin === 'https://www.bkstr.com' && !url.username && !url.password && !url.hash && url.pathname === '/webApp/discoverView'
        && JSON.stringify(parameters) === JSON.stringify(expected), 'Materials URL identity mismatch');
    } else check(row.materialsUrl === undefined, 'Unlisted materials cannot have a URL');
    const matches = catalog.courses.filter(course => course.subject === row.subject && course.number === row.number
      && course.catalogEdition === catalog.catalogEdition && course.campus === campus);
    check(matches.length === 1, `Cannot uniquely map ${row.subject} ${row.number} to ${catalog.catalogEdition}/${campus}`);
    const course = matches[0];
    check(Array.isArray(row.meetings), 'Missing meeting metadata');
    const instructors = [...new Set(row.meetings.map(m => m.instructor).filter(Boolean))].join('; ');
    const body = { courseId: course.id, termId: row.termId, termLabel: row.termLabel, sectionNumber: row.sectionNumber,
      campus, crn: row.crn, sourceUrl, sourceRetrievedAt: row.source.retrievedAt,
      ...(instructors ? { instructor: instructors } : {}), ...(row.materialsUrl ? { materialsUrl: row.materialsUrl } : {}) };
    const record = academic.validateSection(body);
    check(!ids.has(record.id), 'Multiple source sections map to the same database identity'); ids.add(record.id);
    return { body, course, id: record.id, source: { provider: 'calpoly-public-schedule', sourceId: row.id,
      evidenceSha256: row.source.sha256, materialsLinkStatus: row.materialsLinkStatus,
      ...(row.source.capturePath || snapshot.capturePath ? { capturePath: row.source.capturePath || snapshot.capturePath } : {}),
      evidenceFile: row.source.evidenceFile } };
  });
}

async function applySnapshot({ snapshot, catalog, dynamo, tableName, dryRun = false, report }) {
  const academic = api(dynamo, tableName);
  const rows = plan(snapshot, catalog, academic); // Validate every row before any write.
  report.total = rows.length;
  for (const course of new Map(rows.map(r => [r.course.id, r.course])).values()) {
    const stored = (await dynamo.get({ TableName: tableName, Key: { id: course.id }, ConsistentRead: true }).promise()).Item;
    check(stored?.entity === 'course' && stored.subject === course.subject && stored.number === course.number
      && stored.catalogEdition === catalog.catalogEdition && stored.campus === course.campus && !stored.termId && !stored.crn && !stored.instructor,
      `Catalog course is absent or incompatible in the database: ${course.subject} ${course.number}. Start dev:web to seed it.`);
  }
  if (dryRun) { report.validated = rows.length; return; }
  for (const row of rows) {
    try {
      // save() reads the current version, protects admin-owned rows, and uses the
      // same conditional transaction/reference guards as ordinary backend writes.
      const before = (await dynamo.get({ TableName: tableName, Key: { id: row.id }, ConsistentRead: true }).promise()).Item;
      const result = await academic.importSection(row.body, row.source);
      const status = result.protected ? 'protected' : result.created ? 'created' : before?.version === result.record.version ? 'unchanged' : 'updated';
      report[status]++;
      report.records.push({ id: result.record.id, crn: row.body.crn, status });
    } catch (error) {
      report.failures.push({ id: row.id, crn: row.body.crn, message: error.message, statusCode: error.statusCode });
      // Earlier rows may be committed. Stable IDs make restarting safe.
      throw error;
    }
  }
}

async function importSnapshot(options) {
  check(/^campus-essentials-local(?:-[a-zA-Z0-9-]+)?$/.test(options.tableName), 'Only local table names are accepted');
  return applySnapshot(options);
}

async function main(argv = process.argv.slice(2)) {
  const options = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--dry-run') { options.dryRun = true; continue; }
    check(['--snapshot', '--catalog', '--port', '--table', '--report', '--config'].includes(argv[i]) && argv[i + 1], 'Invalid import argument');
    options[argv[i].slice(2)] = argv[++i];
  }
  const config = read(path.resolve(root, options.config || 'config/sections-pipeline.json'));
  const settings = config.databaseImport || {};
  const port = Number(options.port || settings.port || 8765);
  const tableName = options.table || settings.tableName || 'campus-essentials-local';
  validateTarget(port, tableName);
  const snapshots = options.snapshot ? [path.resolve(root, options.snapshot)] : config.jobs.map(job =>
    path.resolve(root, config.outputDir, `${config.term}-${config.campus}-${job.subject}.json`));
  check(!options.report || snapshots.length === 1, '--report needs one --snapshot');
  const catalog = read(path.resolve(root, options.catalog || settings.catalogPath || 'data/catalog/2026-2028.json'));
  // Explicit loopback endpoint and fake credentials. Never use AWS endpoints or credential providers.
  const { dynamo } = localClients(port);
  let failed = false;
  for (const filename of snapshots) {
    const report = { schemaVersion: 1, snapshot: filename, tableName, endpoint: `http://127.0.0.1:${port}`,
      startedAt: new Date().toISOString(), complete: false, dryRun: !!options.dryRun,
      total: 0, created: 0, updated: 0, unchanged: 0, protected: 0, records: [], failures: [] };
    try {
      await importSnapshot({ snapshot: read(filename), catalog, dynamo, tableName, dryRun: options.dryRun, report });
      report.complete = true;
    } catch (error) {
      failed = true;
      if (!report.failures.length) report.failures.push({ message: error.message });
    }
    report.finishedAt = new Date().toISOString();
    const destination = options.report ? path.resolve(root, options.report) : filename.replace(/\.json$/, '.import.report.json');
    atomicJson(destination, report);
    console.log(JSON.stringify({ complete: report.complete, created: report.created, updated: report.updated,
      unchanged: report.unchanged, protected: report.protected, report: destination }));
    if (!report.complete) console.error(report.failures.map(f => f.message).join('\n'));
  }
  return failed ? 1 : 0;
}
module.exports = { plan, contentHash, importSnapshot, applySnapshot, validateTarget, main };
if (require.main === module) main().then(code => { process.exitCode = code; }).catch(error => { console.error(error.message); process.exitCode = 1; });

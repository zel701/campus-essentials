// Explicit cloud entry point; the ordinary local importer stays local-only.
const fs = require('node:fs');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const AWS = require('../lambda/node_modules/aws-sdk');
const { createHandler } = require('../lambda/index');
const { plan, applySnapshot } = require('./import-sections.cjs');
const { createAcademicApi } = require('../lambda/academic-records');
const root = path.resolve(__dirname, '..');
const read = p => JSON.parse(fs.readFileSync(path.resolve(root, p), 'utf8'));
const check = (ok, message) => { if (!ok) throw new Error(message); };

function validateCatalog(catalog) {
  check(catalog.complete === true && catalog.schemaVersion === 1 && Array.isArray(catalog.courses)
    && catalog.courseCount === catalog.courses.length && catalog.courseCount > 0, 'Incomplete catalog');
  const ids = new Set();
  for (const course of catalog.courses) {
    for (const key of ['id', 'subject', 'number', 'title', 'description', 'units', 'sourceUrl', 'retrievedAt', 'campus']) {
      check(typeof course[key] === 'string' && course[key].trim(), `Missing course field: ${key}`);
    }
    const id = 'course:' + createHash('sha256').update(JSON.stringify([course.subject, course.number, course.catalogEdition, '', '', ''])).digest('hex');
    check(course.catalogEdition === catalog.catalogEdition && course.id === id && !ids.has(id), 'Invalid or duplicate catalog identity');
    check(!course.termId && !course.crn && !course.instructor, 'Legacy course records require explicit migration');
    ids.add(id);
  }
}

async function verifiedClients(config) {
  check(/^\d{12}$/.test(config.accountId) && /^us-[a-z]+-\d$/.test(config.region)
    && /^[a-zA-Z0-9_-]+$/.test(config.profile) && config.tableName === 'campus-essentials', 'Invalid AWS deployment target');
  process.env.AWS_SDK_LOAD_CONFIG = '1';
  const credentials = new AWS.SsoCredentials({ profile: config.profile, httpOptions: { connectTimeout: 3000, timeout: 10000 } });
  const options = { region: config.region, credentials, maxRetries: 2, httpOptions: { connectTimeout: 3000, timeout: 10000 } };
  const identity = await new AWS.STS(options).getCallerIdentity().promise();
  check(identity.Account === config.accountId, 'AWS account mismatch; import refused');
  const db = new AWS.DynamoDB(options);
  const { Table: table } = await db.describeTable({ TableName: config.tableName }).promise();
  check(table.TableArn === `arn:aws:dynamodb:${config.region}:${config.accountId}:table/${config.tableName}`
    && table.TableStatus === 'ACTIVE' && table.KeySchema.length === 1
    && table.KeySchema[0].AttributeName === 'id' && table.KeySchema[0].KeyType === 'HASH'
    && table.GlobalSecondaryIndexes?.some(i => i.IndexName === 'by-parent' && i.IndexStatus === 'ACTIVE'),
    'AWS table/schema/index is not ready; deploy the updated stack first');
  return new AWS.DynamoDB.DocumentClient({ service: db });
}

async function main(argv = process.argv.slice(2)) {
  check(argv.every(a => ['--apply', '--dry-run'].includes(a)) && !(argv.includes('--apply') && argv.includes('--dry-run')), 'Use --dry-run (default) or --apply');
  const apply = argv.includes('--apply');
  const config = read('config/aws-deployment.json');
  const catalog = read(config.catalogPath);
  validateCatalog(catalog);
  class HttpError extends Error {}
  const academic = createAcademicApi({ HttpError });
  const snapshots = config.snapshots.map(file => ({ file, snapshot: read(file) }));
  const ids = new Set();
  for (const { snapshot } of snapshots) {
    for (const row of plan(snapshot, catalog, academic)) {
      check(!ids.has(row.id), 'Overlapping snapshot identities'); ids.add(row.id);
    }
  }
  const report = { startedAt: new Date().toISOString(), complete: false, apply,
    accountId: config.accountId, region: config.region, tableName: config.tableName,
    catalogValidated: catalog.courses.length, sectionsValidated: ids.size, coursesWritten: 0, sections: [], failures: [] };
  const dir = path.join(root, '.local/aws/imports');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const destination = path.join(dir, new Date().toISOString().replace(/[:.]/g, '-') + '.json');
  const save = () => fs.writeFileSync(destination, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
  try {
    const dynamo = await verifiedClients(config); // Only identity/schema reads during dry-run.
    if (apply) {
      // Reuse catalog handler validation and entity conditions; credentials remain in memory.
      const password = randomUUID();
      const handler = createHandler({ dynamo, tableName: () => config.tableName, adminPassword: () => password });
      for (let i = 0; i < catalog.courses.length; i += 25) {
        const batch = catalog.courses.slice(i, i + 25);
        const result = await handler({ resource: '/courses/bulk', httpMethod: 'POST',
          headers: { Authorization: 'Bearer ' + password }, body: JSON.stringify({ courses: batch }) });
        const body = JSON.parse(result.body);
        check(result.statusCode === 201 && body.count === batch.length, `Catalog batch failed at row ${i + 1}; earlier writes may exist`);
        report.coursesWritten += batch.length;
        save();
      }
      for (const { file, snapshot } of snapshots) {
        const section = { file, created: 0, updated: 0, unchanged: 0, protected: 0, records: [], failures: [] };
        report.sections.push(section);
        await applySnapshot({ snapshot, catalog, dynamo, tableName: config.tableName, report: section });
        save();
      }
    }
    report.complete = true;
  } catch (error) {
    report.failures.push({ message: error.message });
  } finally {
    report.finishedAt = new Date().toISOString(); save();
  }
  console.log(JSON.stringify({ complete: report.complete, apply, catalog: report.catalogValidated,
    sections: report.sectionsValidated, report: destination, failures: report.failures }));
  return report.complete ? 0 : 1;
}
module.exports = { validateCatalog, verifiedClients, main };
if (require.main === module) main().then(code => { process.exitCode = code; }).catch(error => { console.error(error.message); process.exitCode = 1; });

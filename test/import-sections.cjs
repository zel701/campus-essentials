// Real DynamoDB integration, isolated in-memory process, fake credentials, no persistent writes.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { createHash } = require('node:crypto');
const { localClients, prepareDatabase } = require('../scripts/local-api.cjs');
const { importSnapshot, contentHash, validateTarget } = require('../scripts/import-sections.cjs');
const { createHandler } = require('../lambda/index');
const root = path.resolve(__dirname, '..');
const port = 8768;
const tableName = 'campus-essentials-local-import-test';
const snapshot = JSON.parse(fs.readFileSync(path.join(root, 'data/sections/2268-MAIN-BIO.json')));
const catalog = JSON.parse(fs.readFileSync(path.join(root, 'data/catalog/2026-2028.json')));
const { db, dynamo } = localClients(port);
let child;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const report = () => ({ created: 0, updated: 0, unchanged: 0, protected: 0, records: [], failures: [] });
const run = async (data = snapshot, dryRun = false) => {
  const result = report();
  await importSnapshot({ snapshot: data, catalog, dynamo, tableName, report: result, dryRun });
  return result;
};
const get = async id => (await dynamo.get({ TableName: tableName, Key: { id }, ConsistentRead: true }).promise()).Item;
const guard = id => 'referenceGuard:' + createHash('sha256').update(JSON.stringify([id])).digest('hex');
(async () => {
  assert.throws(() => validateTarget(8765, 'production-table'));
  const probe = net.createServer();
  await new Promise((resolve, reject) => { probe.once('error', reject); probe.listen(port, '127.0.0.1', resolve); });
  await new Promise(resolve => probe.close(resolve));
  child = spawn('java', ['-Djava.library.path=./DynamoDBLocal_lib', '-jar', 'DynamoDBLocal.jar', '-sharedDb', '-inMemory', '-disableTelemetry', '-port', String(port)],
    { cwd: path.join(root, '.local/runtime'), stdio: 'ignore' });
  let ready = false;
  for (let n = 0; n < 60; n++) {
    if (child.exitCode !== null) throw new Error('Isolated database exited');
    try { await db.listTables().promise(); ready = true; break; } catch { await sleep(200); }
  }
  assert.ok(ready);
  await prepareDatabase(db, dynamo, tableName);
  const dry = await run(snapshot, true);
  assert.equal(dry.validated, 177);
  const first = await run();
  assert.equal(first.created, 177);
  const second = await run();
  assert.equal(second.unchanged, 177);
  assert.equal(second.created, 0);
  const item = await get(first.records[0].id);
  const sameCourse = first.records.filter(r => r.id === item.id);
  assert.equal(sameCourse.length, 1);
  const courseCountBefore = (await get(guard(item.courseId))).count;
  const api = createHandler({ dynamo, tableName: () => tableName, adminPassword: () => 'isolated-test-only' });
  const body = Object.fromEntries(['courseId', 'termId', 'sectionNumber', 'campus', 'crn', 'sourceUrl'].map(k => [k, item[k]]));
  const response = await api({ resource: '/sections', httpMethod: 'POST', headers: { 'x-admin-password': 'isolated-test-only' },
    body: JSON.stringify({ ...body, instructor: 'Protected admin correction', expectedVersion: item.version }) });
  assert.equal(response.statusCode, 200, response.body);
  const third = await run();
  assert.equal(third.protected, 1);
  assert.equal(third.unchanged, 176);
  assert.equal((await get(item.id)).instructor, 'Protected admin correction');
  assert.equal((await get(guard(item.courseId))).count, courseCountBefore);
  const deletion = await api({ resource: '/courses/{id}', httpMethod: 'DELETE', pathParameters: { id: item.courseId }, headers: { 'x-admin-password': 'isolated-test-only' } });
  assert.equal(deletion.statusCode, 409);
  await assert.rejects(run({ ...snapshot, mode: 'replay' }), /live snapshots/);
  await assert.rejects(run({ ...snapshot, contentSha256: 'bad' }), /checksum/);
  const changed = structuredClone(snapshot);
  changed.sections.at(-1).number = '9999';
  changed.contentSha256 = contentHash(changed.sections);
  await assert.rejects(run(changed), /Cannot uniquely map/);
  assert.equal((await get(first.records.at(-1).id)).version, 1);
  // Website collection endpoint exposes imported records with stable course references.
  let records = [], token;
  do {
    const response = await api({ resource: '/sections', httpMethod: 'GET', queryStringParameters: { courseId: item.courseId, limit: '1', ...(token ? { nextToken: token } : {}) } });
    assert.equal(response.statusCode, 200);
    const page = JSON.parse(response.body); records.push(...page.sections); token = page.nextToken;
  } while (token);
  assert.equal(records.length, courseCountBefore);
  assert.ok(records.some(r => r.materialsUrl));
  console.log('PASS: 177 imported; 177 unchanged on rerun; admin edit protected; reference guards, pagination, checksum, replay rejection and mapping failures verified.');
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
  if (child && child.exitCode === null) { const exit = once(child, 'exit'); child.kill('SIGTERM'); await exit; }
});

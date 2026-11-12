// Optional integration test: only connects to loopback using fake credentials.
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const AWS = require('../lambda/node_modules/aws-sdk');
const port = Number(process.env.DYNAMODB_LOCAL_PORT || 8765);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid local port');
const db = new AWS.DynamoDB({ endpoint: `http://127.0.0.1:${port}`, region: 'us-west-2',
  credentials: new AWS.Credentials('localtest', 'localtest'), maxRetries: 0,
  httpOptions: { connectTimeout: 1000, timeout: 3000 } });
const RealDocumentClient = AWS.DynamoDB.DocumentClient;
AWS.DynamoDB.DocumentClient = function (options) { return new RealDocumentClient({ ...options, service: db }); };
process.env.TABLE_NAME = 'campus-model-smoke-' + randomUUID();
process.env.ADMIN_PASSWORD = 'local-integration-only';
const { handler } = require('../lambda/index');
const call = (path, method, body, id, query) => handler({ resource: path, path, httpMethod: method,
  headers: { 'x-admin-password': process.env.ADMIN_PASSWORD }, body: JSON.stringify(body),
  pathParameters: id ? { id } : undefined, queryStringParameters: query,
});
async function save(path, body, key, expected = 201) {
  const response = await call(path, 'POST', body);
  assert.equal(response.statusCode, expected, response.body);
  return JSON.parse(response.body)[key];
}
async function remove(path, id, expected = 204) {
  const response = await call(path + '/{id}', 'DELETE', undefined, id);
  assert.equal(response.statusCode, expected, response.body);
}

(async () => {
  await db.createTable({ TableName: process.env.TABLE_NAME, BillingMode: 'PAY_PER_REQUEST',
    KeySchema: [{ AttributeName: 'id', KeyType: 'HASH' }],
    AttributeDefinitions: [{ AttributeName: 'id', AttributeType: 'S' }, { AttributeName: 'parentId', AttributeType: 'S' }],
    GlobalSecondaryIndexes: [{ IndexName: 'by-parent', KeySchema: [{ AttributeName: 'parentId', KeyType: 'HASH' }, { AttributeName: 'id', KeyType: 'RANGE' }], Projection: { ProjectionType: 'ALL' } }],
  }).promise();
  try {
    const course = await save('/courses', { subject: 'TEST', number: '1000', title: 'Local Test', catalogEdition: '2026-2028' }, 'course');
    const sectionBody = { courseId: course.id, termId: '2026-Fall', sectionNumber: '01', campus: 'SLO' };
    const section = await save('/sections', sectionBody, 'section');
    await save('/sections', sectionBody, 'section', 200);
    const updated = await save('/sections', { ...sectionBody, instructor: 'Test Instructor', expectedVersion: 1 }, 'section', 200);
    assert.equal(updated.version, 2);
    assert.equal((await call('/sections', 'POST', { ...sectionBody, expectedVersion: 1 })).statusCode, 409);
    const book = await save('/books', { isbn: '9780306406157', title: 'Test Book', author: 'Test Author', edition: '1', format: 'paperback' }, 'book');
    const requirement = await save('/material-requirements', { sectionId: section.id, bookId: book.id, materialType: 'book', title: 'Textbook', requirementLevel: 'required', verificationStatus: 'verified', sourceUrl: 'https://example.com/syllabus', verifiedAt: '2026-09-24T12:00:00Z' }, 'materialRequirement');
    const offerBody = { bookId: book.id, seller: 'Test Seller', price: 12.25, condition: 'used', purchaseType: 'buy', checkedAt: '2026-09-24T12:00:00Z', url: 'https://example.com/book' };
    const offer = await save('/offers', offerBody, 'offer');
    const revised = await save('/offers', { ...offerBody, price: 10.50, expectedVersion: 1 }, 'offer', 200);
    assert.equal(revised.version, 2);
    const list = await call('/material-requirements', 'GET', undefined, undefined, { sectionId: section.id });
    assert.equal(list.statusCode, 200, list.body);
    assert.equal(JSON.parse(list.body).materialRequirements[0].bookId, book.id);
    // Check real GSI pagination with two sections and a one-record page.
    const other = await save('/sections', { ...sectionBody, sectionNumber: '02' }, 'section');
    const page1 = JSON.parse((await call('/sections', 'GET', undefined, undefined, { courseId: course.id, limit: '1' })).body);
    assert.ok(page1.nextToken);
    const page2 = JSON.parse((await call('/sections', 'GET', undefined, undefined, { courseId: course.id, limit: '1', nextToken: page1.nextToken })).body);
    assert.notEqual(page1.sections[0].id, page2.sections[0].id);
    await remove('/courses', course.id, 409);
    await remove('/sections', section.id, 409);
    await remove('/books', book.id, 409);
    await remove('/material-requirements', requirement.id);
    await remove('/books', book.id, 409);
    await remove('/offers', offer.id);
    await remove('/books', book.id);
    await remove('/sections', section.id);
    await remove('/sections', other.id);
    await remove('/courses', course.id, 200);
    const items = (await new RealDocumentClient({ service: db }).scan({ TableName: process.env.TABLE_NAME }).promise()).Items;
    assert.ok(items.every(item => item.entity === 'referenceGuard' && item.count === 0));
    console.log('DynamoDB Local integration passed: linked records, edits, pagination, and protected deletion.');
  } finally {
    await db.deleteTable({ TableName: process.env.TABLE_NAME }).promise();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });

const mockDb = { get: jest.fn(), put: jest.fn(), delete: jest.fn(), scan: jest.fn(), query: jest.fn(), transactWrite: jest.fn() };
jest.mock('../lambda/node_modules/aws-sdk', () => ({ DynamoDB: { DocumentClient: jest.fn(() => mockDb) } }));
const { handler } = require('../lambda/index.js');
const { createHash } = require('node:crypto');
const rows = new Map<string, any>();
const guardId = (id: string) => 'referenceGuard:' + createHash('sha256').update(JSON.stringify([id])).digest('hex');
const success = (value: any = {}) => ({ promise: async () => value });
const request = (path: string, method = 'GET', body?: any, extra = {}) => ({
  resource: path, path, httpMethod: method, headers: { 'x-admin-password': 'test-password' },
  body: JSON.stringify(body), ...extra,
});
const post = (path: string, body: any) => handler(request(path, 'POST', body));
const record = (response: any, key: string) => {
  expect([200, 201]).toContain(response.statusCode);
  return JSON.parse(response.body)[key];
};
const section = { courseId: 'course-one', termId: '2026-Fall', sectionNumber: '01', campus: 'San Luis Obispo', instructor: 'Example Instructor' };
const book = { isbn: '0-306-40615-2', title: 'Example Book', author: 'Example Author', edition: '1', format: 'paperback' };
const requirement = (sectionId: string, bookId: string) => ({ sectionId, bookId, materialType: 'book', title: 'Course textbook', requirementLevel: 'required' });
const offer = (bookId: string) => ({ bookId, seller: 'Example Seller', price: 25.99, url: 'https://example.com/book', condition: 'used', purchaseType: 'buy', checkedAt: '2026-09-24T12:00:00Z' });

test('API Gateway encoded IDs work for read and versioned deletion; local IDs are not decoded twice', async () => {
  const saved = record(await post('/sections', section), 'section');
  const gateway = { requestContext: { apiId: 'test-api' }, pathParameters: { id: encodeURIComponent(saved.id) } };
  const response = await handler(request('/sections/{id}', 'GET', undefined, gateway));
  expect(JSON.parse(response.body).section.id).toBe(saved.id);
  expect((await handler(request('/sections/{id}', 'DELETE', undefined, {
    ...gateway, queryStringParameters: { expectedVersion: String(saved.version) },
  }))).statusCode).toBe(204);
  rows.set('literal%3Aid', { id: 'literal%3Aid', entity: 'course', title: 'Legacy literal ID' });
  expect((await handler(request('/courses/{id}', 'GET', undefined, { pathParameters: { id: 'literal%3Aid' } }))).statusCode).toBe(200);
  expect((await handler(request('/courses/{id}', 'GET', undefined, {
    requestContext: { apiId: 'test-api' }, pathParameters: { id: 'literal%253Aid' },
  }))).statusCode).toBe(200);
  expect((await handler(request('/courses/{id}', 'GET', undefined, {
    requestContext: { apiId: 'test-api' }, pathParameters: { id: '%not-encoded' },
  }))).statusCode).toBe(400);
});

// Stateful transaction double: evaluates conditions on the original snapshot,
// then applies writes together. This covers reference counts and rejected writes.
function matches(operation: any) {
  const item = rows.get(operation.Key?.id || operation.Item?.id);
  const values = operation.ExpressionAttributeValues || {};
  const condition = operation.ConditionExpression || '';
  if (condition === 'attribute_not_exists(id)') return !item;
  if (condition.includes('attribute_not_exists(#count)')) return !item || item.count === undefined || item.count === 0;
  if (condition === 'attribute_not_exists(id) OR #entity = :entity') return !item || item.entity === values[':entity'];
  if (condition.includes('#entity = :entity') && item?.entity !== values[':entity']) return false;
  if (condition.includes('#version = :version') && item?.version !== values[':version']) return false;
  if (condition.includes('#count >= :one') && !(item?.count >= 1)) return false;
  return true;
}

beforeEach(() => {
  jest.resetAllMocks();
  rows.clear();
  rows.set('course-one', { id: 'course-one', entity: 'course', subject: 'ME', number: '1123' });
  process.env.TABLE_NAME = 'test-table';
  process.env.ADMIN_PASSWORD = 'test-password';
  mockDb.get.mockImplementation(({ Key }) => success({ Item: rows.get(Key.id) }));
  mockDb.put.mockImplementation(({ Item }) => ({ promise: async () => { rows.set(Item.id, Item); } }));
  mockDb.scan.mockImplementation(() => success({ Items: [...rows.values()] }));
  mockDb.query.mockImplementation(({ ExpressionAttributeValues }) => success({ Items: [...rows.values()].filter(row => row.parentId === ExpressionAttributeValues[':parent']) }));
  mockDb.transactWrite.mockImplementation(({ TransactItems }) => ({ promise: async () => {
    const ids = TransactItems.map((item: any) => { const op: any = Object.values(item)[0]; return op.Key?.id || op.Item.id; });
    expect(new Set(ids).size).toBe(ids.length);
    if (!TransactItems.every((item: any) => matches(Object.values(item)[0]))) throw { code: 'TransactionCanceledException' };
    for (const item of TransactItems) {
      if (item.Put) rows.set(item.Put.Item.id, item.Put.Item);
      if (item.Delete) rows.delete(item.Delete.Key.id);
      if (item.Update) {
        const { Key, ExpressionAttributeValues: values } = item.Update;
        rows.set(Key.id, { id: Key.id, entity: 'referenceGuard', count: (rows.get(Key.id)?.count || 0) + values[':delta'] });
      }
    }
  } }));
});

test.each(['sections', 'books', 'material-requirements', 'offers'])('%s writes require admin authorization', async path => {
  expect((await handler(request('/' + path, 'POST', {}, { headers: {} }))).statusCode).toBe(403);
  expect(mockDb.transactWrite).not.toHaveBeenCalled();
});

test('sections belong to the catalog and are separate across terms', async () => {
  const first = record(await post('/sections', section), 'section');
  const second = record(await post('/sections', { ...section, termId: '2027-Spring' }), 'section');
  expect(first.id).not.toBe(second.id);
  expect(rows.get('course-one')).not.toHaveProperty('instructor');
  expect(rows.get(guardId('course-one')).count).toBe(2);
  const list = await handler(request('/sections', 'GET', undefined, { queryStringParameters: { courseId: 'course-one', termId: '2026-Fall' } }));
  expect(JSON.parse(list.body).sections.map((row: any) => row.id)).toEqual([first.id]);
  expect(mockDb.query.mock.calls[0][0]).toMatchObject({ IndexName: 'by-parent' });
});

test('repeated saves are idempotent; edits require the latest version', async () => {
  const saved = record(await post('/sections', section), 'section');
  expect((await post('/sections', section)).statusCode).toBe(200);
  expect(rows.get(guardId('course-one')).count).toBe(1);
  expect((await post('/sections', { ...section, instructor: 'New Instructor' })).statusCode).toBe(409);
  const updated = record(await post('/sections', { ...section, instructor: 'New Instructor', expectedVersion: saved.version }), 'section');
  expect(updated.version).toBe(2);
  expect((await post('/sections', { ...section, expectedVersion: 1 })).statusCode).toBe(409);
  expect(rows.get(guardId('course-one')).count).toBe(1);
});

const importApi = () => require('../lambda/academic-records').createAcademicApi({
  dynamo: mockDb, tableName: () => 'test-table', isAdmin: () => false, headers: {},
  HttpError: class extends Error { constructor(public statusCode: number, message: string) { super(message); } },
});
const importedSection = () => ({ ...section, materialsUrl: 'https://www.bkstr.com/webApp/discoverView?bookstore_id-1=2020&term_id-1=2268&crn-1=6370',
  termLabel: 'Fall Semester 2026', sourceRetrievedAt: '2026-10-28T07:00:00.000Z' });
const provenance = { provider: 'calpoly-public-schedule', sourceId: 'scheduleSection:test', evidenceSha256: 'a'.repeat(64) };

test('internal section import reuses versions and reference guards without duplicating', async () => {
  const api = importApi();
  const first = await api.importSection(importedSection(), provenance);
  expect(first.created).toBe(true);
  // DynamoDB may return map attributes in a different order.
  first.record.sectionImport = Object.fromEntries(Object.entries(first.record.sectionImport).reverse());
  expect((await api.importSection(importedSection(), provenance)).record.version).toBe(1);
  const next = await api.importSection({ ...importedSection(), instructor: 'Changed by official source' }, provenance);
  expect(next.record.version).toBe(2);
  expect(next.record.sectionImport.managedVersion).toBe(2);
  expect(rows.get(guardId('course-one')).count).toBe(1);
});

test('admin edits retain import provenance and permanently protect the row from automated overwrites', async () => {
  const api = importApi();
  const first = await api.importSection(importedSection(), provenance);
  const edited = record(await post('/sections', { ...section, instructor: 'Admin correction', expectedVersion: first.record.version }), 'section');
  expect(edited.materialsUrl).toBe(importedSection().materialsUrl);
  expect(edited.sourceRetrievedAt).toBe(importedSection().sourceRetrievedAt);
  const attempted = await api.importSection(importedSection(), provenance);
  expect(attempted.protected).toBe(true);
  expect(attempted.record.instructor).toBe('Admin correction');
  expect((await post('/sections', { ...section, sectionImport: provenance })).statusCode).toBe(400);
});

test('manual rows and newer observations are not replaced by an import', async () => {
  record(await post('/sections', section), 'section');
  expect((await importApi().importSection(importedSection(), provenance)).protected).toBe(true);
  const body = { ...importedSection(), sectionNumber: '02' };
  await importApi().importSection(body, provenance);
  await expect(importApi().importSection({ ...body, sourceRetrievedAt: '2026-10-27T07:00:00Z' }, provenance)).rejects.toMatchObject({ statusCode: 409 });
});

test('import update still detects a concurrent edit during the transaction', async () => {
  const api = importApi();
  await api.importSection(importedSection(), provenance);
  mockDb.transactWrite.mockImplementationOnce(() => ({ promise: async () => { throw { code: 'TransactionCanceledException' }; } }));
  await expect(api.importSection({ ...importedSection(), instructor: 'New' }, provenance)).rejects.toMatchObject({ statusCode: 409 });
  expect(rows.get(guardId('course-one')).count).toBe(1);
});

test('ISBN-10 and ISBN-13 identify the same edition/format; bad checksums are rejected', async () => {
  const first = record(await post('/books', book), 'book');
  const second = record(await post('/books', { ...book, isbn: '9780306406157' }), 'book');
  expect(first.id).toBe(second.id);
  expect(first.isbn).toBe('9780306406157');
  expect((await post('/books', { ...book, isbn: '9780306406158' })).statusCode).toBe(400);
  const digital = record(await post('/books', { ...book, format: 'ebook' }), 'book');
  expect(digital.id).not.toBe(first.id);
});

test('books without ISBNs keep edition and format in their identity', async () => {
  const { isbn, ...noIsbn } = book;
  const first = record(await post('/books', noIsbn), 'book');
  const second = record(await post('/books', { ...noIsbn, edition: '2' }), 'book');
  expect(first.id).not.toBe(second.id);
});

test('missing/wrong parent types and legacy mixed courses cannot be linked', async () => {
  expect((await post('/sections', { ...section, courseId: 'missing' })).statusCode).toBe(400);
  rows.set('wrong', { id: 'wrong', entity: 'item' });
  expect((await post('/sections', { ...section, courseId: 'wrong' })).statusCode).toBe(400);
  rows.set('legacy', { id: 'legacy', entity: 'course', termId: '2025-Fall' });
  expect((await post('/sections', { ...section, courseId: 'legacy' })).statusCode).toBe(400);
  expect((await post('/material-requirements', requirement('missing', 'wrong'))).statusCode).toBe(400);
  expect(mockDb.transactWrite).not.toHaveBeenCalled();
});

test('verified requirements need evidence and are isolated by section', async () => {
  const s = record(await post('/sections', section), 'section');
  const b = record(await post('/books', book), 'book');
  const body = requirement(s.id, b.id);
  expect((await post('/material-requirements', { ...body, verificationStatus: 'verified' })).statusCode).toBe(400);
  const saved = record(await post('/material-requirements', { ...body, verificationStatus: 'verified', sourceUrl: 'https://example.edu/syllabus', verifiedAt: '2026-09-24T12:00:00Z', accessCodeRequired: true }), 'materialRequirement');
  expect(saved.bookId).toBe(b.id);
  expect(rows.get(guardId(s.id)).count).toBe(1);
  expect(rows.get(guardId(b.id)).count).toBe(1);
  const other = record(await post('/sections', { ...section, sectionNumber: '02' }), 'section');
  const res = await handler(request('/material-requirements', 'GET', undefined, { queryStringParameters: { sectionId: other.id } }));
  expect(JSON.parse(res.body).materialRequirements).toEqual([]);
});

test('non-book materials do not require fabricated book data', async () => {
  const s = record(await post('/sections', section), 'section');
  const saved = record(await post('/material-requirements', { sectionId: s.id, materialType: 'supply', title: 'Safety glasses', requirementLevel: 'required' }), 'materialRequirement');
  expect(saved).not.toHaveProperty('bookId');
  expect(saved.verificationStatus).toBe('unverified');
});

test('offers retain exact-book, price, rental, access-code and freshness data', async () => {
  const b = record(await post('/books', book), 'book');
  const saved = record(await post('/offers', { ...offer(b.id), price: 0 }), 'offer');
  expect(saved.price).toBe(0);
  expect(saved).not.toHaveProperty('shippingPrice');
  expect(saved).not.toHaveProperty('accessCodeIncluded');
  expect((await post('/offers', { ...offer(b.id), purchaseType: 'rent' })).statusCode).toBe(400);
  const rental = record(await post('/offers', { ...offer(b.id), purchaseType: 'rent', rentalDays: 90, shippingPrice: 3.50, accessCodeIncluded: false }), 'offer');
  expect(rental.id).not.toBe(saved.id);
  expect((await post('/offers', { ...offer(b.id), price: 1.001 })).statusCode).toBe(400);
  expect((await post('/offers', { ...offer(b.id), checkedAt: '2026-02-30T12:00:00Z' })).statusCode).toBe(400);
});

test('deletion is blocked until all dependents are removed, including legacy course deletion route', async () => {
  const s = record(await post('/sections', section), 'section');
  const b = record(await post('/books', book), 'book');
  const r = record(await post('/material-requirements', requirement(s.id, b.id)), 'materialRequirement');
  const o = record(await post('/offers', offer(b.id)), 'offer');
  const remove = (path: string, id: string) => handler(request(path + '/{id}', 'DELETE', undefined, { pathParameters: { id } }));
  expect((await remove('/courses', 'course-one')).statusCode).toBe(409);
  expect((await remove('/sections', s.id)).statusCode).toBe(409);
  expect((await remove('/books', b.id)).statusCode).toBe(409);
  expect((await remove('/material-requirements', r.id)).statusCode).toBe(204);
  expect((await remove('/books', b.id)).statusCode).toBe(409);
  expect((await remove('/offers', o.id)).statusCode).toBe(204);
  expect((await remove('/books', b.id)).statusCode).toBe(204);
  expect((await remove('/sections', s.id)).statusCode).toBe(204);
  expect((await remove('/courses', 'course-one')).statusCode).toBe(200);
});

test('creation transaction rechecks a parent that disappears after validation', async () => {
  const execute = mockDb.transactWrite.getMockImplementation()!;
  mockDb.transactWrite.mockImplementation((params: any) => { rows.delete('course-one'); return execute(params); });
  expect((await post('/sections', section)).statusCode).toBe(409);
  expect([...rows.values()].some(row => row.entity === 'section')).toBe(false);
  expect(rows.has(guardId('course-one'))).toBe(false);
});

test('continuation tokens cannot cross collection or parent filters', async () => {
  mockDb.query.mockReturnValue(success({ Items: [], LastEvaluatedKey: { id: 's1', parentId: 'course-one' } }));
  const res = await handler(request('/sections', 'GET', undefined, { queryStringParameters: { courseId: 'course-one' } }));
  const token = JSON.parse(res.body).nextToken;
  expect(token).toBeTruthy();
  expect((await handler(request('/sections', 'GET', undefined, { queryStringParameters: { courseId: 'different', nextToken: token } }))).statusCode).toBe(400);
  expect((await handler(request('/sections', 'GET', undefined, { queryStringParameters: { courseId: 'course-one', nextToken: token } }))).statusCode).toBe(200);
});

test('course writes reject offering data but legacy records remain readable', async () => {
  const legacy = { id: 'legacy', entity: 'course', subject: 'ME', number: '123', title: 'Legacy', instructor: 'Someone', termId: '2025-Fall' };
  rows.set('legacy', legacy);
  const res = await handler(request('/courses/{id}', 'GET', undefined, { pathParameters: { id: 'legacy' } }));
  expect(JSON.parse(res.body).course).toEqual(legacy);
  expect((await post('/courses', legacy)).statusCode).toBe(400);
  expect(rows.get('legacy')).toEqual(legacy);
});

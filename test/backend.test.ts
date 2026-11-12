const mockDynamo = { get: jest.fn(), put: jest.fn(), scan: jest.fn(), delete: jest.fn() };
jest.mock('../lambda/node_modules/aws-sdk', () => ({
  DynamoDB: { DocumentClient: jest.fn(() => mockDynamo) },
}));
const { handler } = require('../lambda/index.js');
const success = (value: unknown = {}) => ({ promise: jest.fn().mockResolvedValue(value) });
const failure = (code: string) => ({ promise: jest.fn().mockRejectedValue({ code }) });
const course = { subject: 'ME', number: '1123', title: 'Mechanics', description: 'Full description', units: '3', prerequisite: 'MATH 1000', corequisite: 'PHYS 1000', recommended: 'Preparation', term: 'F', catalogEdition: '2026-2028' };
const event = (resource: string, method = 'GET', body?: unknown, extra = {}) => ({
  resource, path: resource, httpMethod: method,
  headers: { 'x-admin-password': 'local-test-password' },
  body: body === undefined ? undefined : JSON.stringify(body), ...extra,
});

beforeEach(() => {
  jest.clearAllMocks();
  process.env.TABLE_NAME = 'test-table';
  process.env.ADMIN_PASSWORD = 'local-test-password';
  mockDynamo.get.mockReturnValue(success());
  mockDynamo.put.mockReturnValue(success());
  mockDynamo.scan.mockReturnValue(success({ Items: [] }));
  mockDynamo.delete.mockReturnValue(success());
});

test.each(['/courses', '/items', '/courses/bulk', '/course-items', '/course-items/bulk', '/courses/course-items/bulk'])('denies writes without credentials at %s', async path => {
  const res = await handler(event(path, 'POST', course, { headers: {} }));
  expect(res.statusCode).toBe(403);
  expect(mockDynamo.put).not.toHaveBeenCalled();
});

test('fails closed when the configured password is absent', async () => {
  delete process.env.ADMIN_PASSWORD;
  expect((await handler(event('/verify', 'POST'))).statusCode).toBe(403);
});

test('accepts case-insensitive headers and bearer authentication without logging secrets', async () => {
  const log = jest.spyOn(console, 'log').mockImplementation(() => {});
  try {
    const res = await handler(event('/verify', 'POST', undefined, { headers: { AUTHORIZATION: 'Bearer local-test-password' } }));
    expect(res.statusCode).toBe(200);
    expect(log).not.toHaveBeenCalled();
  } finally { log.mockRestore(); }
});

test.each(['{bad', 'null', '42', '[]'])('rejects malformed or invalid course input %s', async body => {
  expect((await handler(event('/courses', 'POST', undefined, { body }))).statusCode).toBe(400);
  expect(mockDynamo.put).not.toHaveBeenCalled();
});

test('preserves catalog fields on create and bulk import, with stable IDs on retry', async () => {
  const created = await handler(event('/courses', 'POST', course));
  expect(created.statusCode).toBe(201);
  const first = JSON.parse(created.body).course;
  expect(first).toMatchObject(course);
  const imported = await handler(event('/courses/bulk', 'POST', { courses: [course] }));
  expect(imported.statusCode).toBe(201);
  expect(mockDynamo.put.mock.calls[1][0].Item).toMatchObject({ ...course, id: first.id });
  expect(mockDynamo.put.mock.calls[1][0].ConditionExpression).toContain('#entity = :entity');
});

test('validates all imported rows before writing and rejects duplicate identities', async () => {
  expect((await handler(event('/courses/bulk', 'POST', [course, {}]))).statusCode).toBe(400);
  expect((await handler(event('/courses/bulk', 'POST', [course, course]))).statusCode).toBe(400);
  expect(mockDynamo.put).not.toHaveBeenCalled();
});

test('reports partial progress if storage fails during import', async () => {
  const log = jest.spyOn(console, 'error').mockImplementation(() => {});
  try {
    mockDynamo.put.mockReturnValueOnce(success()).mockReturnValueOnce(failure('ProvisionedThroughputExceededException'));
    const res = await handler(event('/courses/bulk', 'POST', [course, { ...course, number: '1124' }]));
    expect(res.statusCode).toBe(503);
    expect(JSON.parse(res.body)).toMatchObject({ completed: 1, remaining: 1 });
    expect(JSON.parse(res.body).count).toBeUndefined();
  } finally { log.mockRestore(); }
});

test('returns a continuation token even when this page has no search matches', async () => {
  mockDynamo.scan.mockReturnValueOnce(success({ Items: [{ entity: 'item' }], LastEvaluatedKey: { id: 'page-one' } }))
    .mockReturnValueOnce(success({ Items: [{ ...course, id: 'c1', entity: 'course' }] }));
  const query = { q: 'ME 1123', limit: '1' };
  const first = JSON.parse((await handler(event('/courses', 'GET', undefined, { queryStringParameters: query }))).body);
  expect(first.courses).toEqual([]);
  expect(first.nextToken).toBeTruthy();
  const second = JSON.parse((await handler(event('/courses', 'GET', undefined, { queryStringParameters: { ...query, nextToken: first.nextToken } }))).body);
  expect(second.courses).toHaveLength(1);
  expect(second.nextToken).toBeNull();
  expect(mockDynamo.scan.mock.calls[1][0]).toMatchObject({ ExclusiveStartKey: { id: 'page-one' }, Limit: 1 });
});

test.each([{ limit: '0' }, { limit: '1001' }, { nextToken: 'invalid' }])('rejects invalid pagination %j', async queryStringParameters => {
  expect((await handler(event('/courses', 'GET', undefined, { queryStringParameters }))).statusCode).toBe(400);
  expect(mockDynamo.scan).not.toHaveBeenCalled();
});

test('retrieves full course data by ID and rejects wrong entity types', async () => {
  mockDynamo.get.mockReturnValueOnce(success({ Item: { ...course, entity: 'course', id: 'c1' } }))
    .mockReturnValueOnce(success({ Item: { entity: 'item', id: 'c1' } }));
  const request = event('/courses/{id}', 'GET', undefined, { pathParameters: { id: 'c1' } });
  expect(JSON.parse((await handler(request)).body).course).toMatchObject(course);
  expect((await handler(request)).statusCode).toBe(404);
});

test('item lookup cannot return a course and item deletion has an entity condition', async () => {
  mockDynamo.get.mockReturnValue(success({ Item: { entity: 'course' } }));
  expect((await handler(event('/items/{id}', 'GET', undefined, { pathParameters: { id: 'c1' } }))).statusCode).toBe(404);
  mockDynamo.delete.mockReturnValue(failure('ConditionalCheckFailedException'));
  expect((await handler(event('/items/{id}', 'DELETE', undefined, { pathParameters: { id: 'c1' } }))).statusCode).toBe(409);
  expect(mockDynamo.delete.mock.calls[0][0].ExpressionAttributeValues).toEqual({ ':entity': 'item' });
});

test.each(['/course-items/{id}', '/courses/course-items/{id}'])('association deletion checks owning course at %s', async path => {
  mockDynamo.get.mockReturnValue(success({ Item: { entity: 'courseItem', courseId: 'different' } }));
  const res = await handler(event(path, 'DELETE', undefined, { pathParameters: { id: 'link' }, queryStringParameters: { courseId: 'c1' } }));
  expect(res.statusCode).toBe(404);
  expect(mockDynamo.delete).not.toHaveBeenCalled();
});

test('allows zero-price items and rejects invalid prices and non-web links', async () => {
  const item = { itemName: 'Book', price: 0, url: 'https://example.com/book' };
  expect((await handler(event('/items', 'POST', item))).statusCode).toBe(201);
  expect((await handler(event('/items', 'POST', { ...item, price: -1 }))).statusCode).toBe(400);
  expect((await handler(event('/items', 'POST', { ...item, url: 'javascript:alert(1)' }))).statusCode).toBe(400);
});

test('stops an import with progress before the Lambda deadline', async () => {
  const log = jest.spyOn(console, 'error').mockImplementation(() => {});
  try {
    const res = await handler(event('/courses/bulk', 'POST', [course]), { getRemainingTimeInMillis: () => 11000 });
    expect(res.statusCode).toBe(503);
    expect(JSON.parse(res.body)).toMatchObject({ completed: 0, remaining: 1 });
    expect(mockDynamo.put).not.toHaveBeenCalled();
  } finally { log.mockRestore(); }
});

test('course-material imports preserve optional status and use stable IDs', async () => {
  const link = { courseId: 'course-one', itemId: 'book-one', required: false, notes: 'Optional reference' };
  const first = await handler(event('/course-items', 'POST', link));
  expect(first.statusCode).toBe(201);
  const saved = JSON.parse(first.body).courseItem;
  expect(saved).toMatchObject(link);
  expect((await handler(event('/courses/course-items/bulk', 'POST', { courseItems: [link] }))).statusCode).toBe(201);
  expect(mockDynamo.put.mock.calls[1][0].Item.id).toBe(saved.id);
});

test.each(['/items', '/course-items'])('list response at %s preserves pagination', async route => {
  mockDynamo.scan.mockReturnValue(success({ Items: [], LastEvaluatedKey: { id: 'last' } }));
  expect(JSON.parse((await handler(event(route))).body).nextToken).toBeTruthy();
});

test('the current catalog imports without losing fields and computes the same stable IDs', async () => {
  const snapshot = require('../data/catalog/2026-2028.json');
  expect(snapshot.complete).toBe(true);
  expect(snapshot.courses.length).toBe(snapshot.courseCount);
  for (let start = 0; start < snapshot.courses.length; start += 100) {
    const courses = snapshot.courses.slice(start, start + 100).map(({ id, ...course }: any) => course);
    expect((await handler(event('/courses/bulk', 'POST', { courses }))).statusCode).toBe(201);
  }
  expect(mockDynamo.put).toHaveBeenCalledTimes(snapshot.courseCount);
  snapshot.courses.forEach((course: any, index: number) => {
    expect(mockDynamo.put.mock.calls[index][0].Item).toMatchObject(course);
  });
});

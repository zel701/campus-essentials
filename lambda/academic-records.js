const { createHash, randomUUID } = require('node:crypto');
const { isDeepStrictEqual } = require('node:util');

const DEFINITIONS = {
  sections: { entity: 'section', singular: 'section', parent: 'courseId' },
  'material-requirements': { entity: 'materialRequirement', singular: 'materialRequirement', parent: 'sectionId' },
  books: { entity: 'book', singular: 'book' },
  offers: { entity: 'offer', singular: 'offer', parent: 'bookId' },
};
const hashId = (entity, parts) => `${entity}:${createHash('sha256').update(JSON.stringify(parts)).digest('hex')}`;
const guardId = id => hashId('referenceGuard', [id]);

function createAcademicApi({ dynamo, tableName, isAdmin, readBody, HttpError, headers }) {
  const bad = message => { throw new HttpError(400, message); };
  const text = (body, key, optional = false) => {
    if (optional && body[key] === undefined) return undefined;
    if (typeof body[key] !== 'string' || !body[key].trim() || body[key].length > 4000) bad(`${key} must be non-empty text (maximum 4000 characters).`);
    if (['courseId', 'sectionId', 'bookId'].includes(key) && Buffer.byteLength(body[key].trim()) > 2048) bad(`${key} exceeds the database key limit.`);
    return body[key].trim();
  };
  const choice = (body, key, choices, fallback) => {
    const value = body[key] === undefined ? fallback : body[key];
    if (!choices.includes(value)) bad(`${key} must be one of: ${choices.join(', ')}.`);
    return value;
  };
  const url = (body, key, optional = false) => {
    const value = text(body, key, optional);
    if (value === undefined) return value;
    try {
      const parsed = new URL(value);
      if (!['https:', 'http:'].includes(parsed.protocol) || parsed.username || parsed.password) throw new Error();
    } catch { bad(`${key} must be an HTTP(S) URL without credentials.`); }
    return value;
  };
  const date = (body, key, optional = false) => {
    const value = text(body, key, optional);
    if (value === undefined) return value;
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value) || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString().replace('.000Z', 'Z') !== value.replace(/\.0{1,3}Z$/, 'Z').replace(/\.(\d{1,2})Z$/, (_, n) => `.${n.padEnd(3, '0')}Z`)) bad(`${key} must be a valid UTC ISO timestamp, e.g. 2026-09-24T12:00:00Z.`);
    return new Date(value).toISOString();
  };
  const boolean = (body, key) => {
    if (body[key] === undefined) return undefined;
    if (typeof body[key] !== 'boolean') bad(`${key} must be a boolean.`);
    return body[key];
  };
  const money = (body, key, optional = false) => {
    const value = body[key];
    if (optional && value === undefined) return undefined;
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1000000 || Math.abs(value * 100 - Math.round(value * 100)) > 1e-7) bad(`${key} must be a non-negative amount with at most two decimal places.`);
    return value;
  };
  function isbn(value) {
    if (value === undefined) return undefined;
    if (typeof value !== 'string') bad('isbn must be text.');
    const normalized = value.replace(/[\s-]/g, '').toUpperCase();
    if (/^\d{9}[\dX]$/.test(normalized)) {
      const sum = [...normalized].reduce((total, digit, index) => total + (10 - index) * (digit === 'X' ? 10 : Number(digit)), 0);
      if (sum % 11) bad('Invalid ISBN-10 checksum.');
      const base = '978' + normalized.slice(0, 9);
      const check = (10 - [...base].reduce((total, digit, index) => total + Number(digit) * (index % 2 ? 3 : 1), 0) % 10) % 10;
      return base + check;
    }
    if (!/^97[89]\d{10}$/.test(normalized) || [...normalized].reduce((total, digit, index) => total + Number(digit) * (index % 2 ? 3 : 1), 0) % 10) bad('Invalid ISBN-13 checksum or prefix.');
    return normalized;
  }

  function build(collection, body) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) bad('Body must be an object.');
    const definition = DEFINITIONS[collection];
    let record;
    let identity;
    if (collection === 'sections') {
      record = {
        courseId: text(body, 'courseId'), termId: text(body, 'termId'),
        sectionNumber: text(body, 'sectionNumber'), campus: text(body, 'campus'),
        instructor: text(body, 'instructor', true), crn: text(body, 'crn', true),
        sourceUrl: url(body, 'sourceUrl', true),
        materialsUrl: url(body, 'materialsUrl', true),
        sourceRetrievedAt: date(body, 'sourceRetrievedAt', true),
        termLabel: text(body, 'termLabel', true),
      };
      identity = [record.courseId, record.termId, record.sectionNumber, record.campus];
    } else if (collection === 'books') {
      record = {
        isbn: isbn(body.isbn), title: text(body, 'title'), author: text(body, 'author'),
        edition: text(body, 'edition'), format: choice(body, 'format', ['paperback', 'hardcover', 'ebook', 'loose-leaf', 'bundle', 'other']),
      };
      identity = record.isbn ? ['isbn', record.isbn, record.format] : ['metadata', record.title, record.author, record.edition, record.format];
    } else if (collection === 'material-requirements') {
      record = {
        sectionId: text(body, 'sectionId'),
        materialType: choice(body, 'materialType', ['book', 'supply', 'software', 'other']),
        title: text(body, 'title'), bookId: text(body, 'bookId', true),
        requirementLevel: choice(body, 'requirementLevel', ['required', 'recommended', 'optional']),
        verificationStatus: choice(body, 'verificationStatus', ['unverified', 'verified'], 'unverified'),
        sourceUrl: url(body, 'sourceUrl', true), verifiedAt: date(body, 'verifiedAt', true),
        notes: text(body, 'notes', true), accessCodeRequired: boolean(body, 'accessCodeRequired'),
      };
      if (record.materialType === 'book' && !record.bookId) bad('Book requirements need bookId.');
      if (record.materialType !== 'book' && record.bookId) bad('Only book requirements may specify bookId.');
      if (record.verificationStatus === 'verified' && (!record.sourceUrl || !record.verifiedAt)) bad('Verified requirements need sourceUrl and verifiedAt.');
      if (record.verificationStatus === 'unverified' && record.verifiedAt) bad('Unverified requirements must not specify verifiedAt.');
      identity = [record.sectionId, record.materialType, record.bookId || record.title];
    } else {
      record = {
        bookId: text(body, 'bookId'), seller: text(body, 'seller'), url: url(body, 'url'),
        price: money(body, 'price'), currency: choice(body, 'currency', ['USD'], 'USD'),
        shippingPrice: money(body, 'shippingPrice', true),
        condition: choice(body, 'condition', ['new', 'used', 'digital', 'unspecified']),
        purchaseType: choice(body, 'purchaseType', ['buy', 'rent', 'borrow']),
        checkedAt: date(body, 'checkedAt'), accessCodeIncluded: boolean(body, 'accessCodeIncluded'),
      };
      if (record.purchaseType === 'rent') {
        if (!Number.isInteger(body.rentalDays) || body.rentalDays < 1 || body.rentalDays > 3650) bad('Rentals require rentalDays from 1 to 3650.');
        record.rentalDays = body.rentalDays;
      } else if (body.rentalDays !== undefined) bad('rentalDays applies only to rental offers.');
      identity = [record.bookId, record.seller, record.url, record.condition, record.purchaseType, record.rentalDays || null];
    }
    const allowed = new Set([...Object.keys(record), 'id', 'expectedVersion']);
    for (const key of Object.keys(body)) if (!allowed.has(key)) bad(`Unknown field: ${key}.`);
    const id = hashId(definition.entity, identity);
    if (body.id !== undefined && body.id !== id) bad('id does not match the record identity; create a new record when changing identity fields.');
    if (body.expectedVersion !== undefined && (!Number.isInteger(body.expectedVersion) || body.expectedVersion < 1)) bad('expectedVersion must be a positive integer.');
    return Object.fromEntries(Object.entries({ ...record, id, entity: definition.entity, schemaVersion: 2, parentId: definition.parent ? record[definition.parent] : undefined }).filter(([, value]) => value !== undefined));
  }

  function references(record) {
    if (record.entity === 'section') return [{ id: record.courseId, entity: 'course' }];
    if (record.entity === 'materialRequirement') return [{ id: record.sectionId, entity: 'section' }, ...(record.bookId ? [{ id: record.bookId, entity: 'book' }] : [])];
    if (record.entity === 'offer') return [{ id: record.bookId, entity: 'book' }];
    return [];
  }
  async function get(id) {
    return (await dynamo.get({ TableName: tableName(), Key: { id }, ConsistentRead: true }).promise()).Item;
  }
  const checkType = reference => ({ ConditionCheck: {
    TableName: tableName(), Key: { id: reference.id }, ConditionExpression: '#entity = :entity',
    ExpressionAttributeNames: { '#entity': 'entity' }, ExpressionAttributeValues: { ':entity': reference.entity },
  } });
  const guardUpdate = (id, delta) => ({ Update: {
    TableName: tableName(), Key: { id: guardId(id) },
    UpdateExpression: 'SET #entity = :entity ADD #count :delta',
    ExpressionAttributeNames: { '#entity': 'entity', '#count': 'count' },
    ExpressionAttributeValues: { ':entity': 'referenceGuard', ':delta': delta, ...(delta < 0 ? { ':one': 1 } : {}) },
    ConditionExpression: delta < 0 ? '#entity = :entity AND #count >= :one' : 'attribute_not_exists(id) OR #entity = :entity',
  } });
  const noReferences = id => ({ ConditionCheck: {
    TableName: tableName(), Key: { id: guardId(id) },
    ConditionExpression: 'attribute_not_exists(#count) OR #count = :zero',
    ExpressionAttributeNames: { '#count': 'count' }, ExpressionAttributeValues: { ':zero': 0 },
  } });
  async function transact(items) {
    try { await dynamo.transactWrite({ TransactItems: items, ClientRequestToken: randomUUID() }).promise(); }
    catch (error) {
      if (error.CancellationReasons?.some(reason => ['ProvisionedThroughputExceeded', 'ThrottlingError'].includes(reason.Code))) throw new HttpError(503, 'Storage is busy; retry the same request.');
      if (error.CancellationReasons?.some(reason => reason.Code === 'ValidationError')) throw new HttpError(500, 'Storage rejected the transaction.');
      if (error.code === 'TransactionCanceledException' || error.code === 'ConditionalCheckFailedException') {
        throw new HttpError(409, 'Record changed, a referenced record is missing, or dependent records still exist. Reload and retry.');
      }
      throw error;
    }
  }
  async function save(collection, body, importSource) {
    const record = build(collection, body);
    const existing = await get(record.id);
    if (existing && existing.entity !== record.entity) throw new HttpError(409, 'ID is already used by a different record type.');
    if (existing && (!Number.isInteger(existing.version) || existing.schemaVersion !== 2)) throw new HttpError(409, 'Existing record needs explicit migration.');
    if (importSource) {
      if (existing && (existing.sectionImport?.managedVersion !== existing.version || existing.sectionImport?.sourceId !== importSource.sourceId)) {
        return { record: existing, created: false, protected: true };
      }
      if (existing && Date.parse(existing.sourceRetrievedAt) > Date.parse(record.sourceRetrievedAt)) {
        throw new HttpError(409, 'Refusing an older section observation.');
      }
      record.sectionImport = { ...importSource, managedVersion: existing?.version || 1 };
      if (existing) body = { ...body, expectedVersion: existing.version };
    } else if (collection === 'sections' && existing?.sectionImport) {
      // These fields are not present in older admin forms. Retain provenance and
      // link metadata; any actual admin edit advances version and protects the row.
      record.sectionImport = existing.sectionImport;
      for (const key of ['materialsUrl', 'sourceRetrievedAt', 'termLabel']) {
        if (body[key] === undefined && existing[key] !== undefined) record[key] = existing[key];
      }
    }
    const unchanged = existing && Object.keys(record).every(key => isDeepStrictEqual(record[key], existing[key])) && Object.keys(existing).every(key => key in record || ['version', 'createdAt', 'updatedAt'].includes(key));
    if (unchanged) return { record: existing, created: false };
    if (existing && body.expectedVersion !== existing.version) throw new HttpError(409, 'Supply the current expectedVersion to update this record.');
    if (!existing && body.expectedVersion !== undefined) throw new HttpError(409, 'Record no longer exists.');
    for (const reference of references(record)) {
      const parent = await get(reference.id);
      if (!parent || parent.entity !== reference.entity) throw new HttpError(400, `Referenced ${reference.entity} does not exist.`);
      if (reference.entity === 'course' && (parent.termId || parent.crn || parent.instructor)) throw new HttpError(400, 'Section must reference a catalog course, not a legacy mixed course/section record.');
    }
    const now = new Date().toISOString();
    const saved = { ...record, version: existing ? existing.version + 1 : 1, createdAt: existing ? existing.createdAt : now, updatedAt: now };
    if (importSource) saved.sectionImport = { ...record.sectionImport, managedVersion: saved.version };
    const put = { Put: {
      TableName: tableName(), Item: saved,
      ConditionExpression: existing ? '#version = :version AND #entity = :entity' : 'attribute_not_exists(id)',
      ...(existing ? { ExpressionAttributeNames: { '#version': 'version', '#entity': 'entity' }, ExpressionAttributeValues: { ':version': existing.version, ':entity': record.entity } } : {}),
    } };
    await transact([put, ...references(record).map(checkType), ...(!existing ? references(record).map(ref => guardUpdate(ref.id, 1)) : [])]);
    return { record: saved, created: !existing };
  }

  async function remove(id, entity, expectedVersion) {
    const record = await get(id);
    if (!record || record.entity !== entity) throw new HttpError(404, 'Record not found.');
    if (expectedVersion !== undefined && String(record.version) !== String(expectedVersion)) throw new HttpError(409, 'Record version changed.');
    await transact([
      noReferences(id),
      { Delete: { TableName: tableName(), Key: { id }, ConditionExpression: '#entity = :entity' + (entity === 'course' ? '' : ' AND #version = :version'),
        ExpressionAttributeNames: { '#entity': 'entity', ...(entity === 'course' ? {} : { '#version': 'version' }) },
        ExpressionAttributeValues: { ':entity': entity, ...(entity === 'course' ? {} : { ':version': record.version }) },
      } },
      ...references(record).map(ref => guardUpdate(ref.id, -1)),
    ]);
  }

  async function list(collection, query) {
    const definition = DEFINITIONS[collection];
    const limit = query.limit === undefined ? 100 : Number(query.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 1000) bad('limit must be from 1 to 1000.');
    const allowed = new Set(['limit', 'nextToken', ...(definition.parent ? [definition.parent] : []), ...(collection === 'sections' ? ['termId'] : []), ...(collection === 'books' ? ['isbn'] : [])]);
    for (const key of Object.keys(query)) if (!allowed.has(key)) bad(`Unsupported filter: ${key}.`);
    const parentId = definition.parent && query[definition.parent];
    const normalizedIsbn = query.isbn === undefined ? undefined : isbn(query.isbn);
    const scope = JSON.stringify([collection, parentId || null, query.termId || null, normalizedIsbn || null]);
    const params = { TableName: tableName(), Limit: limit };
    if (parentId) {
      params.IndexName = 'by-parent';
      params.KeyConditionExpression = 'parentId = :parent';
      params.ExpressionAttributeValues = { ':parent': parentId };
    }
    if (query.nextToken) {
      try {
        const token = JSON.parse(Buffer.from(query.nextToken, 'base64url').toString('utf8'));
        const keys = Object.keys(token.key || {}).sort();
        if (token.scope !== scope || typeof token.key.id !== 'string' || !token.key.id || token.key.id.length > 2048 || JSON.stringify(keys) !== JSON.stringify(parentId ? ['id', 'parentId'] : ['id']) || (parentId && token.key.parentId !== parentId)) throw new Error();
        params.ExclusiveStartKey = token.key;
      } catch { bad('Invalid nextToken for these filters.'); }
    }
    const result = await dynamo[parentId ? 'query' : 'scan'](params).promise();
    const records = (result.Items || []).filter(record => record.entity === definition.entity && (!parentId || record.parentId === parentId) && (!query.termId || record.termId === query.termId) && (!normalizedIsbn || record.isbn === normalizedIsbn));
    return { [collection === 'material-requirements' ? 'materialRequirements' : collection]: records,
      nextToken: result.LastEvaluatedKey ? Buffer.from(JSON.stringify({ scope, key: result.LastEvaluatedKey })).toString('base64url') : null };
  }

  return {
    // Internal local-import interface, deliberately not exposed through HTTP routes.
    validateSection: body => build('sections', body),
    importSection: (body, source) => save('sections', body, source),
    deleteCourse: id => remove(id, 'course'),
    async handle(event, path) {
      const match = /^\/(sections|material-requirements|books|offers)(\/\{id\})?$/.exec(path);
      if (!match) return null;
      const collection = match[1];
      const definition = DEFINITIONS[collection];
      const method = event.httpMethod;
      const reply = (statusCode, body) => ({ statusCode, headers, body: statusCode === 204 ? '' : JSON.stringify(body) });
      if (method !== 'GET' && !isAdmin(event)) throw new HttpError(403, 'Invalid admin password.');
      if (match[2]) {
        const id = event.pathParameters?.id;
        if (!id) bad('id is required.');
        if (method === 'GET') {
          const record = await get(id);
          if (!record || record.entity !== definition.entity) throw new HttpError(404, 'Record not found.');
          return reply(200, { [definition.singular]: record });
        }
        if (method === 'DELETE') {
          await remove(id, definition.entity, event.queryStringParameters?.expectedVersion);
          return reply(204);
        }
      } else {
        if (method === 'GET') return reply(200, await list(collection, event.queryStringParameters || {}));
        if (method === 'POST') {
          const result = await save(collection, readBody(event));
          return reply(result.created ? 201 : 200, { [definition.singular]: result.record });
        }
      }
      return reply(405, { error: 'Method not allowed.' });
    },
  };
}

module.exports = { createAcademicApi };

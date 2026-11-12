const mockIdentity = jest.fn();
const mockDescribe = jest.fn();
const mockDatabase = jest.fn(() => ({ describeTable: mockDescribe }));
jest.mock('../lambda/node_modules/aws-sdk', () => ({
  SsoCredentials: jest.fn(),
  STS: jest.fn(() => ({ getCallerIdentity: mockIdentity })),
  DynamoDB: Object.assign(mockDatabase, { DocumentClient: jest.fn(() => ({})) }),
}));
const { verifiedClients, validateCatalog } = require('../scripts/import-aws.cjs');
const target = { accountId: '127214176503', region: 'us-west-2', profile: 'campus', tableName: 'campus-essentials' };
const table = { TableArn: 'arn:aws:dynamodb:us-west-2:127214176503:table/campus-essentials',
  TableStatus: 'ACTIVE', KeySchema: [{ AttributeName: 'id', KeyType: 'HASH' }],
  GlobalSecondaryIndexes: [{ IndexName: 'by-parent', IndexStatus: 'ACTIVE' }] };
beforeEach(() => {
  jest.clearAllMocks();
  mockIdentity.mockReturnValue({ promise: async () => ({ Account: target.accountId }) });
  mockDescribe.mockReturnValue({ promise: async () => ({ Table: table }) });
});
test('cloud importer refuses a different AWS account before opening the database', async () => {
  mockIdentity.mockReturnValue({ promise: async () => ({ Account: '111111111111' }) });
  await expect(verifiedClients(target)).rejects.toThrow('account mismatch');
  expect(mockDatabase).not.toHaveBeenCalled();
});
test('cloud importer requires the exact ARN and active parent index', async () => {
  for (const altered of [{ ...table, TableArn: table.TableArn.replace('us-west-2', 'us-east-1') },
    { ...table, GlobalSecondaryIndexes: [] }, { ...table, GlobalSecondaryIndexes: [{ IndexName: 'by-parent', IndexStatus: 'CREATING' }] }]) {
    mockDescribe.mockReturnValue({ promise: async () => ({ Table: altered }) });
    await expect(verifiedClients(target)).rejects.toThrow('not ready');
  }
});
test('cloud importer accepts verified target and rejects local table names', async () => {
  await expect(verifiedClients(target)).resolves.toEqual({});
  await expect(verifiedClients({ ...target, tableName: 'campus-essentials-local' })).rejects.toThrow('target');
});
test('catalog validator preserves current stable identities and rejects partial/duplicate/legacy input', () => {
  const catalog = require('../data/catalog/2026-2028.json');
  expect(() => validateCatalog(catalog)).not.toThrow();
  expect(() => validateCatalog({ ...catalog, complete: false })).toThrow('Incomplete');
  expect(() => validateCatalog({ ...catalog, courses: [catalog.courses[0], catalog.courses[0]], courseCount: 2 })).toThrow('duplicate');
  const course = { ...catalog.courses[0], termId: '2268' };
  expect(() => validateCatalog({ ...catalog, courses: [course], courseCount: 1 })).toThrow('Legacy');
});

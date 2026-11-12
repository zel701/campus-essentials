import * as cdk from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { CampusEssentialsStack } from '../lib/campus-essentials-stack';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

test('synthesizes all API routes, admin configuration, CORS and table permissions', () => {
  const outdir = fs.mkdtempSync(path.join(os.tmpdir(), 'campus-cdk-test-'));
  try {
    const app = new cdk.App({ outdir });
    const stack = new CampusEssentialsStack(app, 'TestStack');
    const template = Template.fromStack(stack);
    template.hasResourceProperties('AWS::SecretsManager::Secret', {
      GenerateSecretString: { GenerateStringKey: 'password', PasswordLength: 40 },
    });
    template.hasResource('AWS::DynamoDB::Table', { DeletionPolicy: 'Retain', UpdateReplacePolicy: 'Retain' });
    template.hasResourceProperties('AWS::Lambda::Function', {
      Runtime: 'nodejs22.x', Handler: 'index.handler',
      Environment: { Variables: { TABLE_NAME: Match.anyValue(), ADMIN_PASSWORD: Match.anyValue() } },
    });
    template.hasResourceProperties('AWS::Lambda::Function', {
      Runtime: 'python3.12', Handler: 'lambda_function.handler',
      Environment: { Variables: { TABLE_NAME: Match.anyValue(), ADMIN_PASSWORD: Match.anyValue() } },
    });
    const resources = template.toJSON().Resources;
    const routeFor = (ref: any): string => {
      if (!ref.Ref) return '';
      const node = resources[ref.Ref];
      return routeFor(node.Properties.ParentId) + '/' + node.Properties.PathPart;
    };
    const routes = Object.values(resources).filter((r: any) => r.Type === 'AWS::ApiGateway::Method').map((r: any) => `${r.Properties.HttpMethod} ${routeFor(r.Properties.ResourceId)}`);
    for (const route of ['POST /verify', 'GET /courses', 'POST /courses', 'POST /courses/bulk', 'GET /courses/{id}', 'DELETE /courses/{id}', 'GET /items', 'POST /items', 'GET /items/{id}', 'DELETE /items/{id}', 'POST /scrape']) expect(routes).toContain(route);
    expect(routes).not.toContain('GET /scrape');
    for (const base of ['/sections', '/material-requirements', '/books', '/offers']) {
      for (const route of [`GET ${base}`, `POST ${base}`, `GET ${base}/{id}`, `DELETE ${base}/{id}`, `OPTIONS ${base}`]) expect(routes).toContain(route);
    }
    template.hasResourceProperties('AWS::DynamoDB::Table', {
      KeySchema: [{ AttributeName: 'id', KeyType: 'HASH' }],
      GlobalSecondaryIndexes: [{ IndexName: 'by-parent',
        KeySchema: [{ AttributeName: 'parentId', KeyType: 'HASH' }, { AttributeName: 'id', KeyType: 'RANGE' }],
        Projection: { ProjectionType: 'ALL' },
      }],
    });
    template.hasResourceProperties('AWS::IAM::Policy', {
      Roles: Match.arrayWith([{ Ref: Match.stringLikeRegexp('EssentialsHandlerServiceRole') }]),
      PolicyDocument: Match.objectLike({ Statement: Match.arrayWith([Match.objectLike({ Action: 'dynamodb:ConditionCheckItem', Effect: 'Allow' })]) }),
    });
    for (const base of ['/course-items', '/courses/course-items']) {
      for (const route of [`GET ${base}`, `POST ${base}`, `POST ${base}/bulk`, `DELETE ${base}/{id}`, `OPTIONS ${base}`]) expect(routes).toContain(route);
    }
    template.hasResourceProperties('AWS::IAM::Policy', {
      Roles: Match.arrayWith([{ Ref: Match.stringLikeRegexp('ScraperLambdaServiceRole') }]),
      PolicyDocument: { Statement: Match.arrayWith([Match.objectLike({ Action: Match.arrayWith(['dynamodb:PutItem']), Effect: 'Allow' })]), Version: '2012-10-17' },
    });
    app.synth();
    const assets = fs.readdirSync(outdir).filter(name => name.startsWith('asset.') && fs.statSync(path.join(outdir, name)).isDirectory());
    const pythonAsset = assets.find(name => fs.existsSync(path.join(outdir, name, 'lambda_function.py')));
    expect(pythonAsset).toBeDefined();
    expect(fs.readdirSync(path.join(outdir, pythonAsset!))).toEqual(['lambda_function.py']);
    const nodeAsset = assets.find(name => fs.existsSync(path.join(outdir, name, 'index.js')));
    expect(nodeAsset).toBeDefined();
    expect(fs.existsSync(path.join(outdir, nodeAsset!, 'node_modules/aws-sdk/package.json'))).toBe(true);
  } finally { fs.rmSync(outdir, { recursive: true, force: true }); }
});

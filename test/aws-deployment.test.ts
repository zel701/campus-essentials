import * as cdk from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { CampusEssentialsStack } from '../lib/campus-essentials-stack';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as vm from 'node:vm';

test('website uses private OAC, HTTPS, uncached API with auth forwarding, and protected database', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'campus-aws-'));
  try {
    const build = path.join(directory, 'web');
    fs.mkdirSync(build);
    fs.writeFileSync(path.join(build, 'index.html'), '<!doctype html><title>Test build</title>');
    const app = new cdk.App({ outdir: path.join(directory, 'out'), context: { website: true, websiteDirectory: build, preserveLegacyApi: true } });
    const template = Template.fromStack(new CampusEssentialsStack(app, 'TestStack'));
    template.hasResourceProperties('AWS::S3::Bucket', { PublicAccessBlockConfiguration: {
      BlockPublicAcls: true, BlockPublicPolicy: true, IgnorePublicAcls: true, RestrictPublicBuckets: true,
    }, VersioningConfiguration: { Status: 'Enabled' } });
    template.hasResourceProperties('AWS::CloudFront::OriginAccessControl', {
      OriginAccessControlConfig: Match.objectLike({ SigningBehavior: 'always', SigningProtocol: 'sigv4' }),
    });
    template.hasResourceProperties('AWS::CloudFront::Distribution', { DistributionConfig: Match.objectLike({
      DefaultCacheBehavior: Match.objectLike({ ViewerProtocolPolicy: 'redirect-to-https' }),
      CacheBehaviors: Match.arrayWith([Match.objectLike({ PathPattern: 'api/*',
        CachePolicyId: '4135ea2d-6df8-44a3-9df3-4b5a84be39ad',
        OriginRequestPolicyId: 'b689b0a8-53d0-40ab-baf2-68738e2966ac',
        ViewerProtocolPolicy: 'https-only', AllowedMethods: Match.arrayWith(['GET', 'POST', 'DELETE']),
      })]),
      Origins: Match.arrayWith([Match.objectLike({ OriginPath: Match.anyValue(),
        CustomOriginConfig: Match.objectLike({ OriginProtocolPolicy: 'https-only' }) })]),
    }) });
    template.hasResourceProperties('AWS::DynamoDB::Table', {
      DeletionProtectionEnabled: true, PointInTimeRecoverySpecification: { PointInTimeRecoveryEnabled: true },
    });
    const serialized = JSON.stringify(template.toJSON());
    const resources = template.toJSON().Resources;
    template.resourceCountIs('AWS::ApiGateway::RestApi', 2);
    expect(resources.CampusEssentialsApi17D1C01F).toBeDefined();
    expect(resources.CampusEssentialsApiitemsDELETEBBDAD051).toBeDefined();
    const permissions: any[] = Object.values(resources).filter((r: any) => r.Type === 'AWS::Lambda::Permission');
    const websitePermissions = permissions.filter(r => JSON.stringify(r.Properties.SourceArn).includes('CampusWebsiteApi'));
    expect(websitePermissions).toHaveLength(2);
    expect(websitePermissions.every(r => r.Properties.SourceAccount)).toBe(true);
    expect(resources.CampusEssentialsApiitemsOPTIONSF48EA8ED).toBeUndefined();
    const sectionsOptions: any = Object.values(resources).find((r: any) => r.Type === 'AWS::ApiGateway::Method'
      && r.Properties.HttpMethod === 'OPTIONS' && r.Properties.ResourceId?.Ref?.startsWith('CampusWebsiteApisections'));
    expect(sectionsOptions).toBeDefined();
    const dist: any = Object.values(resources).find((r: any) => r.Type === 'AWS::CloudFront::Distribution');
    const origin = dist.Properties.DistributionConfig.Origins.find((o: any) => o.OriginPath);
    expect(JSON.stringify(origin.OriginPath)).toContain('CampusWebsiteApiDeploymentStageprod');
    expect(serialized).toContain('resolve:secretsmanager:');
    expect(serialized).not.toContain('AdminPassword');
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('SPA rewrite preserves static/catalog errors and API paths, query, and authorization', () => {
  const context = vm.createContext({});
  vm.runInContext(fs.readFileSync('scripts/cloudfront-routes.js', 'utf8'), context);
  for (const [uri, expected] of [['/api/sections', '/sections'], ['/courses/course%3Aabc', '/index.html'],
    ['/admin/books', '/index.html'], ['/catalog/MISSING.json', '/catalog/MISSING.json'], ['/assets/missing.js', '/assets/missing.js']]) {
    const event = { request: { uri, querystring: { term: { value: '2268' } }, headers: { authorization: { value: 'Bearer test-only' } } } };
    const result = context.handler(event);
    expect(result.uri).toBe(expected);
    expect(result.querystring).toEqual(event.request.querystring);
    expect(result.headers).toEqual(event.request.headers);
  }
});

import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as deployment from 'aws-cdk-lib/aws-s3-deployment';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as fs from 'node:fs';

export class CampusWebsite extends Construct {
  constructor(scope: Construct, id: string, api: apigateway.RestApi, directory: string) {
    super(scope, id);
    if (!fs.existsSync(`${directory}/index.html`)) throw new Error('Run npm run build:web before enabling website deployment.');
    const bucket = new s3.Bucket(this, 'Files', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      versioned: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });
    const routing = new cloudfront.Function(this, 'Routes', {
      code: cloudfront.FunctionCode.fromFile({ filePath: 'scripts/cloudfront-routes.js' }),
    });
    const distribution = new cloudfront.Distribution(this, 'Distribution', {
      defaultRootObject: 'index.html',
      minimumProtocolVersion: cloudfront.SecurityPolicyProtocol.TLS_V1_2_2021,
      defaultBehavior: {
        origin: origins.S3BucketOrigin.withOriginAccessControl(bucket),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
        responseHeadersPolicy: cloudfront.ResponseHeadersPolicy.SECURITY_HEADERS,
        functionAssociations: [{ function: routing, eventType: cloudfront.FunctionEventType.VIEWER_REQUEST }],
      },
      additionalBehaviors: {
        'api/*': {
          origin: new origins.RestApiOrigin(api),
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.HTTPS_ONLY,
          allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
          cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
          originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
          functionAssociations: [{ function: routing, eventType: cloudfront.FunctionEventType.VIEWER_REQUEST }],
        },
      },
    });
    new deployment.BucketDeployment(this, 'Publish', {
      sources: [deployment.Source.asset(directory)], destinationBucket: bucket,
      distribution, distributionPaths: ['/*'],
      cacheControl: [deployment.CacheControl.noCache()],
      prune: false,
    });
    new cdk.CfnOutput(cdk.Stack.of(this), 'WebsiteUrl', { value: `https://${distribution.distributionDomainName}` });
  }
}

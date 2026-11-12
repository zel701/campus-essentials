import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as apigateway from "aws-cdk-lib/aws-apigateway";
import { CampusWebsite } from './campus-website';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as iam from 'aws-cdk-lib/aws-iam';

export class CampusEssentialsStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);
    const website = this.node.tryGetContext('website') === 'true' || this.node.tryGetContext('website') === true;

    const adminSecret = new secretsmanager.Secret(this, 'AdminCredential', {
      generateSecretString: { secretStringTemplate: '{"username":"admin"}', generateStringKey: 'password',
        passwordLength: 40, excludePunctuation: true },
    });
    const table = new dynamodb.Table(this, "EssentialsTable", {
      partitionKey: { name: "id", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      tableName: "campus-essentials",
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      deletionProtection: true,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
    });
    table.addGlobalSecondaryIndex({
      indexName: "by-parent",
      partitionKey: { name: "parentId", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "id", type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    });
    const environment = {
      TABLE_NAME: table.tableName,
      ADMIN_PASSWORD: adminSecret.secretValueFromJson('password').unsafeUnwrap(),
      ...(website ? { CORS_ORIGIN: '' } : {}),
    };
    const essentialsLambda = new lambda.Function(this, "EssentialsHandler", {
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: "index.handler",
      code: lambda.Code.fromAsset("lambda", { exclude: [".DS_Store", "**/.DS_Store"] }),
      environment,
      timeout: cdk.Duration.seconds(29),
    });
    table.grantReadWriteData(essentialsLambda);
    table.grant(essentialsLambda, "dynamodb:ConditionCheckItem");

    // This endpoint stores supplied prices; it does not scrape websites.
    // Only deploy the handler. boto3 is provided by the Python Lambda runtime.
    const scraperLambda = new lambda.Function(this, "ScraperLambda", {
      code: lambda.Code.fromAsset("scraper-lambda", {
        exclude: ["**", "!lambda_function.py"],
        ignoreMode: cdk.IgnoreMode.GIT,
      }),
      handler: "lambda_function.handler",
      runtime: lambda.Runtime.PYTHON_3_12,
      environment,
      timeout: cdk.Duration.seconds(15),
      memorySize: 512,
    });
    table.grantWriteData(scraperLambda);

    const preserveLegacyApi = this.node.tryGetContext('preserveLegacyApi') === true;
    if (preserveLegacyApi) {
      // Preserve the original CloudFormation-owned paths and all manually added
      // children. The website API below is managed independently of that legacy tree.
      const legacy = new apigateway.LambdaRestApi(this, 'CampusEssentialsApi', { handler: essentialsLambda, proxy: false });
      const items = legacy.root.addResource('items');
      for (const method of ['GET', 'POST', 'DELETE']) items.addMethod(method);
      legacy.root.addResource('scrape').addMethod('GET', new apigateway.LambdaIntegration(scraperLambda));
    }
    const cors = {
      allowOrigins: apigateway.Cors.ALL_ORIGINS,
      allowMethods: ["OPTIONS", "GET", "POST", "DELETE"],
      allowHeaders: [...apigateway.Cors.DEFAULT_HEADERS, "x-admin-password"],
    };
    // A single permission scoped to this API avoids per-route Lambda policy growth.
    const proxy = (fn: lambda.IFunction) => new apigateway.Integration({
      type: apigateway.IntegrationType.AWS_PROXY, integrationHttpMethod: 'POST',
      uri: cdk.Fn.join('', ['arn:', cdk.Aws.PARTITION, ':apigateway:', cdk.Aws.REGION,
        ':lambda:path/2015-03-31/functions/', fn.functionArn, '/invocations']),
    });
    const api = new apigateway.RestApi(this, preserveLegacyApi ? 'CampusWebsiteApi' : 'CampusEssentialsApi', {
      defaultIntegration: proxy(essentialsLambda),
      deployOptions: { throttlingRateLimit: 20, throttlingBurstLimit: 40 },
    });
    essentialsLambda.addPermission('WebsiteApiInvoke', { principal: new iam.ServicePrincipal('apigateway.amazonaws.com'),
      sourceArn: api.arnForExecuteApi('*', '/*', '*'), sourceAccount: this.account });
    scraperLambda.addPermission('WebsiteScrapeInvoke', { principal: new iam.ServicePrincipal('apigateway.amazonaws.com'),
      sourceArn: api.arnForExecuteApi('POST', '/scrape', '*'), sourceAccount: this.account });
    api.root.addCorsPreflight(cors);
    const addResource = (parent: apigateway.IResource, name: string) => {
      const resource = parent.addResource(name);
      resource.addCorsPreflight(cors);
      return resource;
    };
    addResource(api.root, "verify").addMethod("POST");
    for (const name of ["items", "courses"]) {
      const collection = addResource(api.root, name);
      collection.addMethod("GET");
      collection.addMethod("POST");
      const record = addResource(collection, "{id}");
      record.addMethod("GET");
      record.addMethod("DELETE");
      if (name === "courses") addResource(collection, "bulk").addMethod("POST");
    }
    for (const name of ["sections", "material-requirements", "books", "offers"]) {
      const collection = addResource(api.root, name);
      collection.addMethod("GET");
      collection.addMethod("POST");
      const record = addResource(collection, "{id}");
      record.addMethod("GET");
      record.addMethod("DELETE");
    }
    // Keep the nested route expected by the original handler and a shorter alias.
    for (const parent of [api.root, api.root.getResource("courses")!]) {
      const associations = addResource(parent, "course-items");
      associations.addMethod("GET");
      associations.addMethod("POST");
      addResource(associations, "bulk").addMethod("POST");
      addResource(associations, "{id}").addMethod("DELETE");
    }
    addResource(api.root, "scrape").addMethod("POST", proxy(scraperLambda));
    new cdk.CfnOutput(this, "ApiUrl", { value: api.url });
    new cdk.CfnOutput(this, 'TableName', { value: table.tableName });
    new cdk.CfnOutput(this, 'AdminSecretArn', { value: adminSecret.secretArn });
    if (website) new CampusWebsite(this, 'Website', api, this.node.tryGetContext('websiteDirectory') || 'web/dist');
  }
}

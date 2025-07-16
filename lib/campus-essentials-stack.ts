import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
export class CampusEssentialsStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // Define a DynamoDB table
    const table = new dynamodb.Table(this, 'EssentialsTable', {
      partitionKey: { name: 'id', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      tableName: 'campus-essentials',
      removalPolicy: cdk.RemovalPolicy.DESTROY, // NOT recommended for production
    });
      // Define Lambda function
    const essentialsLambda = new lambda.Function(this, 'EssentialsHandler', {
      runtime: lambda.Runtime.NODEJS_18_X,
      handler: 'index.handler',
      code: lambda.Code.fromAsset('lambda'),   // folder name
      environment: {
        TABLE_NAME: table.tableName,            // pass table name to Lambda
      },
    });

    // Give Lambda permission to read/write DynamoDB table
    table.grantReadWriteData(essentialsLambda);
    
    // Create API Gateway REST API resource backed by our Lambda function
  const api = new apigateway.LambdaRestApi(this, 'CampusEssentialsApi', {
    handler: essentialsLambda,
    proxy: false,  // Disable automatic catch-all routing
  });

  // Create a specific resource path: POST /items
  const items = api.root.addResource('items');
  items.addMethod('POST');  // Allow POST requests
  items.addMethod('GET'); // Allow Get
  items.addMethod('DELETE'); //Allow delete
  }
}

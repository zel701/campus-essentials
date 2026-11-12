#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { CampusEssentialsStack } from '../lib/campus-essentials-stack';
import * as fs from 'node:fs';

const app = new cdk.App();
const target = JSON.parse(fs.readFileSync('config/aws-deployment.json', 'utf8'));
app.node.setContext('preserveLegacyApi', target.preserveLegacyApi === true);
new CampusEssentialsStack(app, 'CampusEssentialsStack', {
  env: { account: target.accountId, region: target.region },
  /* If you don't specify 'env', this stack will be environment-agnostic.
   * Account/Region-dependent features and context lookups will not work,
   * but a single synthesized template can be deployed anywhere. */

  /* Uncomment the next line to specialize this stack for the AWS Account
   * and Region that are implied by the current CLI configuration. */
  // env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: process.env.CDK_DEFAULT_REGION },

  /* Uncomment the next line if you know exactly what Account and Region you
   * want to deploy the stack to. */
  // env: { account: '123456789012', region: 'us-east-1' },

  /* For more information, see https://docs.aws.amazon.com/cdk/latest/guide/environments.html */
});

#!/usr/bin/env node
import * as cdk from "aws-cdk-lib";
import { AuthStack } from "../lib/auth-stack";
import { KmsStack } from "../lib/kms-stack";

const app = new cdk.App();

// AuthStack — deployed to real AWS (the only real-AWS resource, Cognito free tier)
// Deploy with: cdk deploy AuthStack -c googleClientId=<id> -c googleClientSecret=<secret>
new AuthStack(app, "AuthStack", {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION ?? "us-east-1",
  },
  description: "Eventform Cognito User Pool with Google federation",
});

// KmsStack — deployed to LocalStack via: cdklocal deploy KmsStack
// See infra/cdk/lib/kms-stack.ts for the interplay with the compose boot hook.
new KmsStack(app, "KmsStack", {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT ?? "000000000000",
    region: process.env.CDK_DEFAULT_REGION ?? "us-east-1",
  },
  description: "Eventform KMS key (EXTERNAL origin) for LocalStack",
});

#!/usr/bin/env node
import * as cdk from "aws-cdk-lib";
import { AuthStack } from "../lib/auth-stack";
import { BackupStack } from "../lib/backup-stack";
import { CertStack } from "../lib/cert-stack";
import { KmsStack } from "../lib/kms-stack";

const app = new cdk.App();

const env = {
  account: process.env.CDK_DEFAULT_ACCOUNT,
  region: process.env.CDK_DEFAULT_REGION ?? "us-east-1",
};

// Branded auth domain is opt-in: -c customAuthDomain=auth.murugappan.dev
// creates CertStack (ACM cert, DNS-validated via Cloudflare) and wires the
// certificate into AuthStack's Cognito custom domain.
const customAuthDomain = app.node.tryGetContext("customAuthDomain") as string | undefined;

const certStack = customAuthDomain
  ? new CertStack(app, "CertStack", {
      env,
      domainName: customAuthDomain,
      description: "ACM certificate for the branded Cognito hosted-UI domain",
    })
  : undefined;

// AuthStack — deployed to real AWS (the only real-AWS resources, Cognito free tier)
// Deploy with: cdk deploy CertStack AuthStack -c googleClientId=<id> -c googleClientSecret=<secret> [-c customAuthDomain=...]
new AuthStack(app, "AuthStack", {
  env,
  description: "Eventform Cognito User Pool with Google federation",
  customAuthDomain,
  authCertificate: certStack?.certificate,
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

// BackupStack — append-only S3 target for nightly pg_dump uploads from the VPS.
new BackupStack(app, "BackupStack", {
  env,
  description: "EventForm append-only Postgres backup bucket",
});

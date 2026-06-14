#!/usr/bin/env node
import * as cdk from "aws-cdk-lib";
import { AuthStack } from "../lib/auth-stack";
import { CertStack } from "../lib/cert-stack";
import { ComputeStack } from "../lib/compute-stack";

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

// ComputeStack — EC2 ASG (scale-to-zero capable) running the container stack.
// Requires a default VPC + concrete account/region (CDK_DEFAULT_ACCOUNT/REGION)
// for the VPC lookup. Deploy with: cdk deploy ComputeStack
// Region: set CDK_DEFAULT_REGION=eu-west-2 (London) — co-located with the
// Neon DB (also eu-west-2), so the API↔DB hop is in-region. London is the
// best-balanced choice for an India + Europe + US audience (lowest worst-case
// user latency). Cognito/CertStack stay in us-east-1 (JWKS is cached).
new ComputeStack(app, "ComputeStack", {
  env,
  description: "EventForm EC2 ASG running the Docker Compose app stack",
});

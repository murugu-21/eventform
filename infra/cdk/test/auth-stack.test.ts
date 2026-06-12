import { describe, it, expect } from "vitest";
import * as cdk from "aws-cdk-lib";
import * as acm from "aws-cdk-lib/aws-certificatemanager";
import { Template, Match } from "aws-cdk-lib/assertions";
import { AuthStack } from "../lib/auth-stack";

function makeStack() {
  const app = new cdk.App({
    context: {
      googleClientId: "dummy-client-id",
      googleClientSecret: "dummy-client-secret",
      cognitoDomainPrefix: "eventform-auth",
    },
  });
  return new AuthStack(app, "AuthStack", {
    env: { account: "123456789012", region: "us-east-1" },
  });
}

describe("AuthStack", () => {
  it("creates a UserPool with self-signup disabled", () => {
    const template = Template.fromStack(makeStack());
    template.hasResourceProperties("AWS::Cognito::UserPool", {
      AdminCreateUserConfig: { AllowAdminCreateUserOnly: true },
    });
  });

  it("creates a Google identity provider with correct scopes", () => {
    const template = Template.fromStack(makeStack());
    template.hasResourceProperties("AWS::Cognito::UserPoolIdentityProvider", {
      ProviderName: "Google",
      ProviderType: "Google",
      ProviderDetails: {
        authorize_scopes: "openid email profile",
      },
    });
  });

  it("creates an app client with authorization-code grant and no secret", () => {
    const template = Template.fromStack(makeStack());
    template.hasResourceProperties("AWS::Cognito::UserPoolClient", {
      AllowedOAuthFlows: ["code"],
      GenerateSecret: false,
    });
  });

  it("app client callback URLs include both prod and localhost", () => {
    const template = Template.fromStack(makeStack());
    template.hasResourceProperties("AWS::Cognito::UserPoolClient", {
      CallbackURLs: [
        "https://eventform.murugappan.dev/auth/callback",
        "http://localhost:5173/auth/callback",
      ],
    });
  });

  it("app client logout URLs include both prod and localhost", () => {
    const template = Template.fromStack(makeStack());
    template.hasResourceProperties("AWS::Cognito::UserPoolClient", {
      LogoutURLs: [
        "https://eventform.murugappan.dev",
        "http://localhost:5173",
      ],
    });
  });

  it("app client has Google in SupportedIdentityProviders", () => {
    const template = Template.fromStack(makeStack());
    template.hasResourceProperties("AWS::Cognito::UserPoolClient", {
      SupportedIdentityProviders: Match.arrayWith(["Google"]),
    });
  });

  it("creates a Cognito hosted domain with the configured prefix", () => {
    const template = Template.fromStack(makeStack());
    template.hasResourceProperties("AWS::Cognito::UserPoolDomain", {
      Domain: "eventform-auth",
    });
  });

  it("adds a custom domain (with cert) only when props are provided", () => {
    // without props: exactly one domain (the prefix one)
    Template.fromStack(makeStack()).resourceCountIs("AWS::Cognito::UserPoolDomain", 1);

    // with props: prefix + custom domain with the ACM cert attached
    const app = new cdk.App({
      context: {
        googleClientId: "dummy-client-id",
        googleClientSecret: "dummy-client-secret",
        cognitoDomainPrefix: "eventform-auth",
      },
    });
    const certHolder = new cdk.Stack(app, "TestCertHolder", {
      env: { account: "123456789012", region: "us-east-1" },
    });
    const stack = new AuthStack(app, "AuthStack", {
      env: { account: "123456789012", region: "us-east-1" },
      customAuthDomain: "auth.murugappan.dev",
      authCertificate: acm.Certificate.fromCertificateArn(
        certHolder,
        "Cert",
        "arn:aws:acm:us-east-1:123456789012:certificate/00000000-0000-0000-0000-000000000000",
      ),
    });
    const template = Template.fromStack(stack);
    template.resourceCountIs("AWS::Cognito::UserPoolDomain", 2);
    template.hasResourceProperties("AWS::Cognito::UserPoolDomain", {
      Domain: "auth.murugappan.dev",
      CustomDomainConfig: {
        CertificateArn: Match.stringLikeRegexp("certificate/00000000"),
      },
    });
  });
});

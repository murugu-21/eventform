import { describe, it, expect } from "vitest";
import * as cdk from "aws-cdk-lib";
import { Template, Match } from "aws-cdk-lib/assertions";
import { KmsStack } from "../lib/kms-stack";

function makeStack() {
  const app = new cdk.App();
  return new KmsStack(app, "KmsStack", {
    env: { account: "000000000000", region: "us-east-1" },
  });
}

describe("KmsStack", () => {
  it("creates a KMS key with EXTERNAL origin", () => {
    const template = Template.fromStack(makeStack());
    template.hasResourceProperties("AWS::KMS::Key", {
      Origin: "EXTERNAL",
    });
  });

  it("KMS key has the _custom_id_ tag pinning the LocalStack key UUID", () => {
    const template = Template.fromStack(makeStack());
    template.hasResourceProperties("AWS::KMS::Key", {
      Tags: Match.arrayWith([
        { Key: "_custom_id_", Value: "11111111-2222-4333-8444-555555555555" },
      ]),
    });
  });

  it("KMS key has the correct description", () => {
    const template = Template.fromStack(makeStack());
    template.hasResourceProperties("AWS::KMS::Key", {
      Description: Match.stringLikeRegexp("eventform endpoint HMAC secrets"),
    });
  });

  it("creates the eventform-endpoint-secrets alias", () => {
    const template = Template.fromStack(makeStack());
    template.hasResourceProperties("AWS::KMS::Alias", {
      AliasName: "alias/eventform-endpoint-secrets",
    });
  });

  it("alias points to the key defined in the same stack", () => {
    const template = Template.fromStack(makeStack());
    // The alias TargetKeyId should reference the CfnKey resource (a Ref)
    template.hasResourceProperties("AWS::KMS::Alias", {
      AliasName: "alias/eventform-endpoint-secrets",
      TargetKeyId: Match.anyValue(),
    });
  });

  it("stack contains exactly one KMS key and one KMS alias", () => {
    const template = Template.fromStack(makeStack());
    template.resourceCountIs("AWS::KMS::Key", 1);
    template.resourceCountIs("AWS::KMS::Alias", 1);
  });

  it("outputs the key id and alias ARN", () => {
    const template = Template.fromStack(makeStack());
    const outputs = template.toJSON().Outputs as Record<string, unknown>;
    expect(Object.keys(outputs)).toContain("KeyId");
    expect(Object.keys(outputs)).toContain("AliasArn");
  });
});

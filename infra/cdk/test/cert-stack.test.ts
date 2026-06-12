import { describe, it } from "vitest";
import * as cdk from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { CertStack } from "../lib/cert-stack";

describe("CertStack", () => {
  it("creates a DNS-validated certificate for the auth domain", () => {
    const app = new cdk.App();
    const stack = new CertStack(app, "CertStack", {
      env: { account: "123456789012", region: "us-east-1" },
      domainName: "auth.murugappan.dev",
    });
    const template = Template.fromStack(stack);
    template.hasResourceProperties("AWS::CertificateManager::Certificate", {
      DomainName: "auth.murugappan.dev",
      ValidationMethod: "DNS",
    });
  });
});

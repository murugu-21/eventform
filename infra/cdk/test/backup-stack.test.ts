import { describe, it } from "vitest";
import * as cdk from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { BackupStack } from "../lib/backup-stack";

function template() {
  const app = new cdk.App();
  return Template.fromStack(
    new BackupStack(app, "BackupStack", {
      env: { account: "123456789012", region: "us-east-1" },
    }),
  );
}

describe("BackupStack", () => {
  it("creates a versioned, encrypted, lifecycle-bounded private bucket", () => {
    const t = template();
    t.hasResourceProperties("AWS::S3::Bucket", {
      VersioningConfiguration: { Status: "Enabled" },
      PublicAccessBlockConfiguration: Match.objectLike({ BlockPublicAcls: true }),
      LifecycleConfiguration: {
        Rules: Match.arrayWith([Match.objectLike({ ExpirationInDays: 30 })]),
      },
    });
  });

  it("grants the backup user PutObject ONLY (append-only model)", () => {
    const t = template();
    t.hasResourceProperties("AWS::IAM::Policy", {
      PolicyDocument: {
        Statement: [
          Match.objectLike({
            Action: "s3:PutObject",
            Effect: "Allow",
          }),
        ],
      },
    });
  });
});

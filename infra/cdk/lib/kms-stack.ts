import * as cdk from "aws-cdk-lib";
import * as kms from "aws-cdk-lib/aws-kms";
import { Construct } from "constructs";

/**
 * KmsStack — IaC source of truth for the eventform endpoint-secrets KMS key.
 *
 * Target: LocalStack via `cdklocal deploy KmsStack`
 *
 * The key is created with Origin=EXTERNAL so key material must be imported after creation.
 * The `_custom_id_` tag pins the LocalStack key to a fixed UUID so that ciphertexts encrypted
 * against the key remain valid across LocalStack restarts (the UUID never changes).
 *
 * Interplay with the compose boot hook (infra/compose/localstack/ready.d/01-import-kms-key.sh):
 *   - KmsStack is the IaC source of truth: it declares the key + alias as infrastructure.
 *   - The boot hook is an idempotent fallback for key-material import AND for creating the key
 *     if KmsStack was never deployed (e.g. a fresh dev checkout that only does `docker compose up`).
 *   - Deployment order: `cdklocal deploy KmsStack` first, then the boot hook only needs to import
 *     material (the key already exists). On a LocalStack restart the hook re-imports material.
 *   - Fresh environments: the boot hook creates the key if it doesn't exist, matching this spec.
 *
 * NOTE: If KmsStack is deployed on top of a LocalStack container that already has the key
 * (created by the boot hook), CloudFormation will attempt `CreateKey` with the same `_custom_id_`
 * tag. LocalStack may raise an error because a key with that tag already exists. This is expected.
 * KmsStack is intended for FRESH environments; for existing containers, rely on the boot hook.
 * See README for the FRESH-environment live-verification procedure.
 */
export class KmsStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // EXTERNAL origin: AWS (and LocalStack) holds no key material until it is imported.
    // The _custom_id_ tag is a LocalStack extension that pins the key to a fixed UUID,
    // ensuring any ciphertext remains decryptable after container restarts.
    const cfnKey = new kms.CfnKey(this, "EndpointSecretsKey", {
      description: "eventform endpoint HMAC secrets — EXTERNAL origin, material imported by boot hook",
      origin: "EXTERNAL",
      enabled: true,
      enableKeyRotation: false,
      keyPolicy: {
        Version: "2012-10-17",
        Statement: [
          {
            Sid: "Enable IAM User Permissions",
            Effect: "Allow",
            Principal: { AWS: `arn:aws:iam::${this.account}:root` },
            Action: "kms:*",
            Resource: "*",
          },
        ],
      },
      tags: [
        {
          // LocalStack extension: pins the key id to this fixed UUID.
          // Ciphertexts encrypted before a restart remain valid after re-import.
          key: "_custom_id_",
          value: "11111111-2222-4333-8444-555555555555",
        },
      ],
    });

    // Alias used by all eventform services: alias/eventform-endpoint-secrets
    new kms.CfnAlias(this, "EndpointSecretsAlias", {
      aliasName: "alias/eventform-endpoint-secrets",
      targetKeyId: cfnKey.ref,
    });

    new cdk.CfnOutput(this, "KeyId", {
      value: cfnKey.ref,
      description: "KMS key ID (should be 11111111-2222-4333-8444-555555555555 in LocalStack)",
    });

    new cdk.CfnOutput(this, "AliasArn", {
      value: `arn:aws:kms:${this.region}:${this.account}:alias/eventform-endpoint-secrets`,
      description: "KMS alias ARN",
    });
  }
}

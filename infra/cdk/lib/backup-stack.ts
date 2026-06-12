import * as cdk from "aws-cdk-lib";
import * as iam from "aws-cdk-lib/aws-iam";
import * as s3 from "aws-cdk-lib/aws-s3";
import { Construct } from "constructs";

/**
 * Postgres backup target: an append-only S3 bucket.
 *
 * Security model: the VPS holds credentials for `eventform-backup`, whose
 * only permission is s3:PutObject on this bucket. Combined with bucket
 * versioning, a compromised VPS can add objects but cannot read, list,
 * delete, or destructively overwrite existing backups.
 *
 * Cost: dumps are KB–MB gzip files; lifecycle expires current objects after
 * 30 days and noncurrent versions after 7 — storage rounds to ~$0.
 */
export class BackupStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const bucket = new s3.Bucket(this, "BackupBucket", {
      bucketName: `eventform-backups-${this.account}`,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      versioned: true,
      enforceSSL: true,
      lifecycleRules: [
        {
          id: "expire-old-backups",
          expiration: cdk.Duration.days(30),
          noncurrentVersionExpiration: cdk.Duration.days(7),
          abortIncompleteMultipartUploadAfter: cdk.Duration.days(2),
        },
      ],
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    const backupUser = new iam.User(this, "BackupUser", {
      userName: "eventform-backup",
    });
    backupUser.addToPolicy(
      new iam.PolicyStatement({
        sid: "AppendOnlyBackupWrites",
        actions: ["s3:PutObject"],
        resources: [bucket.arnForObjects("pg/*")],
      }),
    );

    new cdk.CfnOutput(this, "BackupBucketName", {
      value: bucket.bucketName,
      description: "Set as BACKUP_S3_BUCKET on the VPS",
    });
    new cdk.CfnOutput(this, "BackupUserName", {
      value: backupUser.userName,
      description:
        "Create an access key yourself: aws iam create-access-key --user-name eventform-backup",
    });
  }
}

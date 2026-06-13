import * as cdk from "aws-cdk-lib";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as autoscaling from "aws-cdk-lib/aws-autoscaling";
import * as iam from "aws-cdk-lib/aws-iam";
import { Construct } from "constructs";

/**
 * EC2 Auto Scaling Group that runs the EventForm container stack.
 *
 * Design notes / hard assumptions (see DEPLOYMENT.md):
 *  - The ASG recycles instances (scale, replace-on-failure, scale-to-zero), so
 *    the box MUST be stateless: Postgres is on **Neon** (external) and the only
 *    on-box state (the Redpanda log) is disposable. A local Postgres container
 *    would lose all data on any instance replacement — do NOT run one here.
 *  - Ingress is the **Cloudflare Tunnel** (cloudflared dials out), so the
 *    security group opens **no inbound ports**. Shell access is via SSM Session
 *    Manager (no SSH, no key pair).
 *  - Secrets are read at boot from SSM Parameter Store under `/eventform/*`
 *    (SecureString) — nothing sensitive is baked into the launch template.
 *  - Graviton (ARM) t4g.small (2 GB) — the trimmed stack measures ~1.3 GiB.
 *    Images are multi-arch (linux/arm64). Override via `-c instanceSize=`.
 *
 * Scale-to-zero: minCapacity 0 / maxCapacity 1. This stack provisions the ASG;
 * the wake (SPA gate → Lambda → SetDesiredCapacity=1) and idle-stop (→ 0) pieces
 * are separate. desiredCapacity defaults to 1 so a fresh deploy boots; a later
 * `cdk deploy` will reset it to 1 (deploys are infrequent — fine).
 */
export class ComputeStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const instanceSize = (this.node.tryGetContext("instanceSize") as string | undefined) ?? "small";
    const repoUrl =
      (this.node.tryGetContext("repoUrl") as string | undefined) ??
      "https://github.com/murugu-21/eventform";

    // Use the account's default VPC and its public subnets. A public subnet +
    // auto-assigned public IPv4 gives the box outbound internet (GHCR pulls,
    // Neon, Cognito, the tunnel dial-out) with no NAT gateway. The public IPv4
    // is billed only while an instance is running — scale-to-zero friendly.
    const vpc = ec2.Vpc.fromLookup(this, "DefaultVpc", { isDefault: true });

    // No inbound rules — the tunnel is outbound-only and access is via SSM.
    const securityGroup = new ec2.SecurityGroup(this, "InstanceSg", {
      vpc,
      description: "EventForm app box — no inbound; egress all (tunnel dials out)",
      allowAllOutbound: true,
    });

    const role = new iam.Role(this, "InstanceRole", {
      assumedBy: new iam.ServicePrincipal("ec2.amazonaws.com"),
      description: "EventForm EC2 instance role: SSM Session Manager + read /eventform/* params",
      managedPolicies: [
        // Session Manager shell access (no SSH port needed).
        iam.ManagedPolicy.fromAwsManagedPolicyName("AmazonSSMManagedInstanceCore"),
      ],
    });
    // Read the app's SecureString secrets at boot.
    role.addToPolicy(
      new iam.PolicyStatement({
        actions: ["ssm:GetParameter", "ssm:GetParameters"],
        resources: [`arn:aws:ssm:${this.region}:${this.account}:parameter/eventform/*`],
      }),
    );

    const userData = ec2.UserData.forLinux();
    userData.addCommands(
      "set -euxo pipefail",
      "dnf update -y",
      "dnf install -y docker git awscli",
      "systemctl enable --now docker",
      // Docker Compose v2 plugin (aarch64)
      "mkdir -p /usr/local/lib/docker/cli-plugins",
      "curl -fSL https://github.com/docker/compose/releases/latest/download/docker-compose-linux-aarch64 -o /usr/local/lib/docker/cli-plugins/docker-compose",
      "chmod +x /usr/local/lib/docker/cli-plugins/docker-compose",
      // Fetch the app
      `git clone ${repoUrl} /opt/eventform`,
      "cd /opt/eventform/infra/compose",
      // Materialize .env from SSM SecureString params (region from the stack)
      `REGION=${this.region}`,
      "get() { aws ssm get-parameter --region \"$REGION\" --name \"$1\" --with-decryption --query Parameter.Value --output text; }",
      "{",
      '  echo "DATABASE_URL=$(get /eventform/database-url)"',
      '  echo "DATABASE_URL_API=$(get /eventform/database-url-api)"',
      '  echo "DATABASE_URL_WORKER=$(get /eventform/database-url-worker)"',
      '  echo "SECRET_ENC_KEY=$(get /eventform/secret-enc-key)"',
      '  echo "TUNNEL_TOKEN=$(get /eventform/tunnel-token)"',
      '  echo "COGNITO_ISSUER=$(get /eventform/cognito-issuer)"',
      '  echo "COGNITO_CLIENT_ID=$(get /eventform/cognito-client-id)"',
      "} > .env",
      "chmod 600 .env",
      // Pull prebuilt images and start the stack. Migrations run in CI against
      // Neon (deploy.yml `migrate` job), not on the box.
      "docker compose -f docker-compose.prod.yml pull",
      "docker compose -f docker-compose.prod.yml up -d",
    );

    const launchTemplate = new ec2.LaunchTemplate(this, "LaunchTemplate", {
      instanceType: ec2.InstanceType.of(
        ec2.InstanceClass.T4G,
        instanceSize as ec2.InstanceSize,
      ),
      machineImage: ec2.MachineImage.latestAmazonLinux2023({
        cpuType: ec2.AmazonLinuxCpuType.ARM_64,
      }),
      role,
      securityGroup,
      userData,
      requireImdsv2: true,
      blockDevices: [
        {
          deviceName: "/dev/xvda",
          volume: ec2.BlockDeviceVolume.ebs(16, {
            volumeType: ec2.EbsDeviceVolumeType.GP3,
            encrypted: true,
            deleteOnTermination: true,
          }),
        },
      ],
    });

    const asg = new autoscaling.AutoScalingGroup(this, "Asg", {
      vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
      launchTemplate,
      minCapacity: 0,
      maxCapacity: 1,
      desiredCapacity: 1,
    });

    new cdk.CfnOutput(this, "AsgName", {
      value: asg.autoScalingGroupName,
      description: "Scale 0↔1 with: aws autoscaling set-desired-capacity --auto-scaling-group-name <this> --desired-capacity {0|1}",
    });
  }
}

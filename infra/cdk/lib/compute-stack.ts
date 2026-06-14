import * as path from "node:path";
import * as cdk from "aws-cdk-lib";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as autoscaling from "aws-cdk-lib/aws-autoscaling";
import * as iam from "aws-cdk-lib/aws-iam";
import * as acm from "aws-cdk-lib/aws-certificatemanager";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as apigwv2 from "aws-cdk-lib/aws-apigatewayv2";
import { HttpJwtAuthorizer } from "aws-cdk-lib/aws-apigatewayv2-authorizers";
import { HttpLambdaIntegration } from "aws-cdk-lib/aws-apigatewayv2-integrations";
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
      description: "EventForm app box - no inbound; egress all (tunnel dials out)",
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
      // Scale-to-zero: the API (non-root `node`, uid 1000) stamps its
      // last-activity file into this bind-mounted dir; pre-create it owned by
      // 1000 so the container can write and the idle-check (root) can read.
      "mkdir -p /opt/eventform/infra/compose/state",
      "chown 1000:1000 /opt/eventform/infra/compose/state",
      // Pull prebuilt images and start the stack. Migrations run in CI against
      // Neon (deploy.yml `migrate` job), not on the box.
      "docker compose -f docker-compose.prod.yml pull",
      "docker compose -f docker-compose.prod.yml up -d",
      // Scale-to-zero idle-stop: install the systemd timer that runs idle-check.sh
      // (sets this ASG's desired capacity to 0 after 30 min of no real requests).
      "chmod +x /opt/eventform/infra/prod/idle-check.sh",
      "cp /opt/eventform/infra/systemd/eventform-idle.service /etc/systemd/system/",
      "cp /opt/eventform/infra/systemd/eventform-idle.timer /etc/systemd/system/",
      "systemctl daemon-reload",
      "systemctl enable --now eventform-idle.timer",
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
      description: "Scale 0<->1 with: aws autoscaling set-desired-capacity --auto-scaling-group-name <this> --desired-capacity {0|1}",
    });

    // ── GitHub Actions OIDC: a keyless deploy role for the `rollout` job ────────
    // The deploy workflow assumes this role via GitHub's OIDC provider instead of
    // storing long-lived AWS access keys in repo secrets (safer for a public repo).
    // Trust is scoped to THIS repo's `production` environment; permissions are
    // exactly the ASG instance-refresh the rollout performs — nothing more.
    const githubRepo =
      (this.node.tryGetContext("githubRepo") as string | undefined) ?? "murugu-21/eventform";
    // An account can hold only ONE provider per URL; pass an existing one via
    // `-c githubOidcProviderArn=...` to import instead of creating a duplicate.
    const existingOidcArn = this.node.tryGetContext("githubOidcProviderArn") as string | undefined;
    const oidcProvider = existingOidcArn
      ? iam.OpenIdConnectProvider.fromOpenIdConnectProviderArn(this, "GithubOidc", existingOidcArn)
      : new iam.OpenIdConnectProvider(this, "GithubOidc", {
          url: "https://token.actions.githubusercontent.com",
          clientIds: ["sts.amazonaws.com"],
        });

    const deployRole = new iam.Role(this, "GithubDeployRole", {
      roleName: "eventform-github-deploy",
      description: "Assumed by GitHub Actions (OIDC) to roll the EventForm ASG - no static keys",
      maxSessionDuration: cdk.Duration.hours(1),
      assumedBy: new iam.OpenIdConnectPrincipal(oidcProvider, {
        StringEquals: {
          "token.actions.githubusercontent.com:aud": "sts.amazonaws.com",
          // Only the `production` environment of this repo may assume the role.
          "token.actions.githubusercontent.com:sub": `repo:${githubRepo}:environment:production`,
        },
      }),
    });
    // DescribeAutoScalingGroups has no resource-level scoping → must be "*".
    deployRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ["autoscaling:DescribeAutoScalingGroups"],
        resources: ["*"],
      }),
    );
    // The only mutation, scoped to THIS ASG.
    deployRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ["autoscaling:StartInstanceRefresh"],
        resources: [asg.autoScalingGroupArn],
      }),
    );

    new cdk.CfnOutput(this, "GithubDeployRoleArn", {
      value: deployRole.roleArn,
      description: "Set as the GitHub Actions variable AWS_ROLE_ARN; the rollout job assumes it via OIDC (no access keys)",
    });

    // ── Scale-to-zero: idle-stop (on-box) + wake (API Gateway) ─────────────────
    // SCALE-DOWN is free and on-box: a systemd timer runs idle-check.sh, which —
    // when there have been no real (non-/health) requests for 30 min — sets this
    // ASG's desired capacity to 0 (the instance terminates; Neon holds the data).
    // The instance role needs to set its own ASG's capacity. Referencing the ASG
    // ARN directly here would be circular (ASG -> launch template -> role), so we
    // scope by name pattern off the stack name instead — no construct reference.
    const asgArnPattern = `arn:aws:autoscaling:${this.region}:${this.account}:autoScalingGroup:*:autoScalingGroupName/${this.stackName}*`;
    role.addToPolicy(
      new iam.PolicyStatement({
        actions: ["autoscaling:SetDesiredCapacity"],
        resources: [asgArnPattern],
      }),
    );
    role.addToPolicy(
      new iam.PolicyStatement({
        // No resource-level scoping on these describes.
        actions: ["autoscaling:DescribeAutoScalingInstances", "autoscaling:DescribeAutoScalingGroups"],
        resources: ["*"],
      }),
    );

    // SCALE-UP (wake): the SPA's ApiHealthGate POSTs to this endpoint when the
    // backend is down. API Gateway validates the visitor's Cognito JWT, then a
    // Lambda sets desired=1. Keyless (Lambda exec role); no public AWS surface.
    // Gated on the Cognito config — pass `-c cognitoIssuer=<issuer> -c
    // cognitoClientId=<id>` (same pool the app verifies) to provision it.
    const cognitoIssuer = this.node.tryGetContext("cognitoIssuer") as string | undefined;
    const cognitoClientId = this.node.tryGetContext("cognitoClientId") as string | undefined;
    const webOrigin =
      (this.node.tryGetContext("webOrigin") as string | undefined) ?? "https://eventform.murugappan.dev";
    // Custom domain for the wake endpoint → https://<domain>/<basePath>/wake.
    // The ACM cert (REGIONAL, this region) must be created + DNS-validated by the
    // operator (murugappan.dev is on Cloudflare, not Route53), then passed by ARN.
    const wakeDomainName =
      (this.node.tryGetContext("wakeDomainName") as string | undefined) ?? "api-gateway-ind.murugappan.dev";
    const wakeBasePath = (this.node.tryGetContext("wakeBasePath") as string | undefined) ?? "eventform";
    const wakeCertArn = this.node.tryGetContext("wakeCertArn") as string | undefined;

    if (cognitoIssuer && cognitoClientId) {
      const wakeFn = new lambda.Function(this, "WakeFn", {
        runtime: lambda.Runtime.NODEJS_20_X,
        handler: "index.handler",
        code: lambda.Code.fromAsset(path.join(__dirname, "..", "lambda", "wake")),
        timeout: cdk.Duration.seconds(10),
        environment: { ASG_NAME: asg.autoScalingGroupName },
        description: "EventForm wake: sets the ASG desired capacity to 1",
      });
      // No launch-template dependency on the Lambda, so the precise ASG ARN is safe here.
      wakeFn.addToRolePolicy(
        new iam.PolicyStatement({
          actions: ["autoscaling:SetDesiredCapacity"],
          resources: [asg.autoScalingGroupArn],
        }),
      );
      wakeFn.addToRolePolicy(
        new iam.PolicyStatement({
          actions: ["autoscaling:DescribeAutoScalingGroups"],
          resources: ["*"],
        }),
      );

      const wakeApi = new apigwv2.HttpApi(this, "WakeApi", {
        description: "EventForm wake endpoint (Cognito-authorized)",
        corsPreflight: {
          allowOrigins: [webOrigin],
          allowMethods: [apigwv2.CorsHttpMethod.POST, apigwv2.CorsHttpMethod.OPTIONS],
          allowHeaders: ["authorization", "content-type"],
        },
      });
      wakeApi.addRoutes({
        path: "/wake",
        methods: [apigwv2.HttpMethod.POST],
        integration: new HttpLambdaIntegration("WakeIntegration", wakeFn),
        authorizer: new HttpJwtAuthorizer("WakeJwtAuthorizer", cognitoIssuer, {
          jwtAudience: [cognitoClientId],
        }),
      });

      // Custom domain + base-path mapping → /<basePath>/wake on the branded host.
      // Gated on the cert ARN (the cert + its DNS validation are operator-owned,
      // since the zone is on Cloudflare). Without it, fall back to the default
      // execute-api URL so the stack still deploys.
      let wakeUrl = `${wakeApi.apiEndpoint}/wake`;
      if (wakeCertArn) {
        const wakeDomain = new apigwv2.DomainName(this, "WakeDomain", {
          domainName: wakeDomainName,
          certificate: acm.Certificate.fromCertificateArn(this, "WakeCert", wakeCertArn),
        });
        new apigwv2.ApiMapping(this, "WakeApiMapping", {
          api: wakeApi,
          domainName: wakeDomain,
          apiMappingKey: wakeBasePath,
        });
        wakeUrl = `https://${wakeDomainName}/${wakeBasePath}/wake`;
        new cdk.CfnOutput(this, "WakeDomainTarget", {
          value: wakeDomain.regionalDomainName,
          description: `DNS: CNAME ${wakeDomainName} -> this target (DNS-only / NOT proxied — API Gateway terminates TLS with the ACM cert)`,
        });
      }

      new cdk.CfnOutput(this, "WakeUrl", {
        value: wakeUrl,
        description: "Set as the SPA's VITE_WAKE_URL (Cloudflare Pages env); the ApiHealthGate POSTs here to wake the box",
      });
    } else {
      new cdk.CfnOutput(this, "WakeApiNote", {
        value: "Wake endpoint not provisioned — pass -c cognitoIssuer=<issuer> -c cognitoClientId=<clientId> to enable it.",
      });
    }
  }
}

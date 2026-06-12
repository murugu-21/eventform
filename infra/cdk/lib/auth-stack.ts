import * as cdk from "aws-cdk-lib";
import * as acm from "aws-cdk-lib/aws-certificatemanager";
import * as cognito from "aws-cdk-lib/aws-cognito";
import { Construct } from "constructs";

export interface AuthStackProps extends cdk.StackProps {
  /** Branded hosted-UI domain (e.g. auth.murugappan.dev); requires authCertificate. */
  customAuthDomain?: string;
  /** ISSUED us-east-1 ACM cert for customAuthDomain (from CertStack). */
  authCertificate?: acm.ICertificate;
}

export class AuthStack extends cdk.Stack {
  /** https://cognito-idp.<region>.amazonaws.com/<poolId> */
  public readonly issuerUrl: string;
  public readonly clientId: string;
  public readonly hostedDomainUrl: string;

  constructor(scope: Construct, id: string, props?: AuthStackProps) {
    super(scope, id, props);

    // Context-injected values; pass via: cdk deploy -c googleClientId=… -c googleClientSecret=…
    const googleClientId = this.node.tryGetContext("googleClientId") as string | undefined;
    const googleClientSecret = this.node.tryGetContext("googleClientSecret") as string | undefined;
    const cognitoDomainPrefix = (this.node.tryGetContext("cognitoDomainPrefix") as string | undefined) ?? "eventform-auth";
    const webHost = (this.node.tryGetContext("webHost") as string | undefined) ?? "eventform.murugappan.dev";

    if (!googleClientId) throw new Error("Context key 'googleClientId' is required (-c googleClientId=<id>)");
    if (!googleClientSecret) throw new Error("Context key 'googleClientSecret' is required (-c googleClientSecret=<secret>)");

    // User pool — no self-signup; email auto-verified through Google IdP
    const userPool = new cognito.UserPool(this, "UserPool", {
      userPoolName: "eventform-users",
      selfSignUpEnabled: false,
      signInAliases: { email: true },
      autoVerify: { email: true },
      standardAttributes: {
        email: { required: true, mutable: true },
      },
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    // Google Identity Provider
    // NOTE: SecretValue.unsafePlainText is used here for simplicity.
    // For production, store the secret in Secrets Manager and reference it via
    // SecretValue.secretsManager("google-oauth-client-secret").
    const googleIdp = new cognito.UserPoolIdentityProviderGoogle(this, "GoogleIdP", {
      userPool,
      clientId: googleClientId,
      // eslint-disable-next-line @typescript-eslint/no-deprecated
      clientSecretValue: cdk.SecretValue.unsafePlainText(googleClientSecret),
      scopes: ["openid", "email", "profile"],
      attributeMapping: {
        email: cognito.ProviderAttribute.GOOGLE_EMAIL,
        fullname: cognito.ProviderAttribute.GOOGLE_NAME,
        profilePicture: cognito.ProviderAttribute.GOOGLE_PICTURE,
      },
    });

    // Hosted domain (Cognito-managed domain) — kept alongside the custom
    // domain as a fallback; a pool may have one of each.
    const domain = userPool.addDomain("HostedDomain", {
      cognitoDomain: { domainPrefix: cognitoDomainPrefix },
    });

    // Optional branded custom domain (e.g. auth.murugappan.dev), wired from
    // bin/eventform.ts as a cross-stack reference to CertStack's certificate.
    // Requires an existing A record on the parent domain.
    const customAuthDomain = props?.customAuthDomain;
    if (customAuthDomain && props.authCertificate) {
      const customDomain = userPool.addDomain("CustomDomain", {
        customDomain: {
          domainName: customAuthDomain,
          certificate: props.authCertificate,
        },
      });
      // CNAME target for the DNS record (CloudFront distribution behind the
      // custom domain) — exposed via CloudFormation GetAtt, no extra resources.
      const cfnDomain = customDomain.node.defaultChild as cognito.CfnUserPoolDomain;
      new cdk.CfnOutput(this, "CustomDomainTarget", {
        value: cfnDomain.getAtt("CloudFrontDistribution").toString(),
        description: `Point a DNS-only CNAME for ${customAuthDomain} at this target`,
      });
      new cdk.CfnOutput(this, "CustomDomainUrl", {
        value: `https://${customAuthDomain}`,
        description: "Branded hosted UI base URL (use as VITE_COGNITO_DOMAIN)",
      });
    }

    // App client — authorization-code grant + PKCE, NO client secret
    const appClient = new cognito.UserPoolClient(this, "AppClient", {
      userPool,
      userPoolClientName: "eventform-web",
      // No client secret — SPA uses PKCE
      generateSecret: false,
      authFlows: {
        // Only allow authorization-code via the hosted UI
      },
      oAuth: {
        flows: { authorizationCodeGrant: true },
        scopes: [
          cognito.OAuthScope.OPENID,
          cognito.OAuthScope.EMAIL,
          cognito.OAuthScope.PROFILE,
        ],
        callbackUrls: [
          `https://${webHost}/auth/callback`,
          "http://localhost:5173/auth/callback",
        ],
        logoutUrls: [
          `https://${webHost}`,
          "http://localhost:5173",
        ],
      },
      supportedIdentityProviders: [cognito.UserPoolClientIdentityProvider.GOOGLE],
    });

    // The app client must be created after the Google IdP is registered
    appClient.node.addDependency(googleIdp);

    // ---- Outputs ----
    this.issuerUrl = `https://cognito-idp.${this.region}.amazonaws.com/${userPool.userPoolId}`;
    this.clientId = appClient.userPoolClientId;
    this.hostedDomainUrl = domain.baseUrl();

    new cdk.CfnOutput(this, "IssuerUrl", {
      value: this.issuerUrl,
      description: "Cognito token issuer URL (set as COGNITO_ISSUER)",
    });

    new cdk.CfnOutput(this, "ClientId", {
      value: this.clientId,
      description: "Cognito app client ID (set as COGNITO_CLIENT_ID / VITE_COGNITO_CLIENT_ID)",
    });

    new cdk.CfnOutput(this, "HostedDomain", {
      value: this.hostedDomainUrl,
      description: "Cognito hosted UI base URL (set as VITE_COGNITO_DOMAIN)",
    });
  }
}

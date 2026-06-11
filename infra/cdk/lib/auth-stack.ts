import * as cdk from "aws-cdk-lib";
import * as cognito from "aws-cdk-lib/aws-cognito";
import { Construct } from "constructs";

export class AuthStack extends cdk.Stack {
  /** https://cognito-idp.<region>.amazonaws.com/<poolId> */
  public readonly issuerUrl: string;
  public readonly clientId: string;
  public readonly hostedDomainUrl: string;

  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
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

    // Hosted domain (Cognito-managed domain)
    const domain = userPool.addDomain("HostedDomain", {
      cognitoDomain: { domainPrefix: cognitoDomainPrefix },
    });

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

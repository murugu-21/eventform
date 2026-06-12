import * as cdk from "aws-cdk-lib";
import * as acm from "aws-cdk-lib/aws-certificatemanager";
import { Construct } from "constructs";

export interface CertStackProps extends cdk.StackProps {
  /** Domain the certificate covers, e.g. auth.murugappan.dev */
  domainName: string;
}

/**
 * ACM certificate for the branded Cognito hosted-UI domain.
 *
 * DNS lives outside Route53 (Cloudflare), so CloudFormation cannot complete
 * the DNS validation itself: the FIRST deploy of this stack waits in
 * CREATE_IN_PROGRESS until the ACM validation CNAME exists in Cloudflare.
 * Read the record from the ACM console or:
 *   aws acm list-certificates / describe-certificate
 * ACM validation records are deterministic per (domain, account), so the
 * record only ever needs to be added once.
 */
export class CertStack extends cdk.Stack {
  public readonly certificate: acm.ICertificate;

  constructor(scope: Construct, id: string, props: CertStackProps) {
    super(scope, id, props);

    this.certificate = new acm.Certificate(this, "AuthDomainCert", {
      domainName: props.domainName,
      // No hostedZone: emits the validation CNAME for out-of-band (Cloudflare) DNS.
      validation: acm.CertificateValidation.fromDns(),
    });

    new cdk.CfnOutput(this, "CertificateArn", {
      value: this.certificate.certificateArn,
      description: `ACM certificate for ${props.domainName}`,
    });
  }
}

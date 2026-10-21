import { Construct } from "constructs";
import * as cdk from 'aws-cdk-lib';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import { OriginHeader } from './originAccess';

export default (
  self: Construct,
  vpc: cdk.aws_ec2.Vpc,
  lbSecurityGroup: cdk.aws_ec2.SecurityGroup,
  asgWeb: cdk.aws_autoscaling.AutoScalingGroup,
  // Both default to today's behaviour: listeners open to the world, and every
  // request forwarded. See cdk/originAccess.ts.
  access: { openListeners: boolean; originHeader?: OriginHeader } = { openListeners: true },
) => {
  const lb = new elbv2.ApplicationLoadBalancer(self, 'Lb', {
    vpc,
    internetFacing: true,
    securityGroup: lbSecurityGroup, // Use the dedicated ALB security group
    idleTimeout: cdk.Duration.seconds(300),
  });

  const webTargetGroup = new elbv2.ApplicationTargetGroup(self, 'WebAppTargetGroup', {
    vpc,
    port: 80,
    protocol: elbv2.ApplicationProtocol.HTTP,
    targets: [asgWeb],
    healthCheck: {
      path: "/api/v3/testConnection",
      interval: cdk.Duration.seconds(300)
    }
  });

  // With an origin header required, a request without it gets 403 and only a
  // matching request reaches the web instances. Load balancer health checks
  // go straight to the targets and are not affected.
  const { originHeader } = access;
  const routing = originHeader
    ? { defaultAction: elbv2.ListenerAction.fixedResponse(403, { contentType: 'text/plain', messageBody: 'Forbidden' }) }
    : { defaultTargetGroups: [webTargetGroup] };
  const requireHeader = (listener: elbv2.ApplicationListener, id: string) => {
    if (!originHeader) return;
    listener.addAction(id, {
      priority: 1,
      conditions: [elbv2.ListenerCondition.httpHeader(originHeader.name, [originHeader.value])],
      action: elbv2.ListenerAction.forward([webTargetGroup]),
    });
  };

  const httpListener = lb.addListener('HttpListener', {
    port: 80,
    open: access.openListeners,
    ...routing,
  });
  requireHeader(httpListener, 'HttpOriginHeader');

  const certificate = new acm.Certificate(self, 'WebAppCertificate', {
    domainName: 'pol.is',
    validation: acm.CertificateValidation.fromDns(),
  });

  const httpsListener = lb.addListener('HttpsListener', {
    port: 443,
    certificates: [certificate],
    open: access.openListeners,
    ...routing,
  });
  requireHeader(httpsListener, 'HttpsOriginHeader');

  const webScalingPolicy = asgWeb.scaleOnRequestCount('WebScalingPolicy', {
    targetRequestsPerMinute: 600,
  });

  return {
    lb,
    webTargetGroup,
    httpListener,
    httpsListener,
    webScalingPolicy
  }
}
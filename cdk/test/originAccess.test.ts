import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { CdkStack } from '../lib/cdk-stack';
import {
  ALB_INGRESS_CIDRS_CONTEXT, ALB_INGRESS_CIDRS_FILE_CONTEXT, ALB_INGRESS_PREFIX_LIST_CONTEXT,
  DEFAULT_ORIGIN_HEADER_NAME, ORIGIN_HEADER_NAME_CONTEXT, ORIGIN_HEADER_SECRET_CONTEXT,
  REQUIRE_ORIGIN_HEADER_CONTEXT, RESTRICT_ALB_INGRESS_CONTEXT, readCidrsFile, validateIpv4Cidr,
} from '../originAccess';

// The production stack as deployed (`-c enableCiEc2=true`), bundling skipped.
const stack = (context: Record<string, unknown> = {}, props: Record<string, unknown> = {}) => {
  const app = new cdk.App({ context: { 'aws:cdk:bundling-stacks': [], enableCiEc2: true, ...context } });
  return new CdkStack(app, 'CdkStack', {
    env: { account: '123456789012', region: 'us-east-1' },
    envFile: '/dev/null',
    enableSSHAccess: false,
    enableOllama: false,
    ...props,
  });
};
const synth = (context: Record<string, unknown> = {}) => Template.fromStack(stack(context));

type Rule = { group: string; port: number; cidr?: string; sourceGroup?: string; prefixList?: string };
const groupId = (logicalId: string) => logicalId;
const refOf = (v: any): string | undefined => v?.['Fn::GetAtt']?.[0] ?? v?.Ref;

// Every inbound rule in the template, inline or as a separate resource.
const ingress = (t: Template): Rule[] => {
  const rules: Rule[] = [];
  const res = t.toJSON().Resources as Record<string, any>;
  for (const [id, r] of Object.entries(res)) {
    if (r.Type === 'AWS::EC2::SecurityGroup') {
      for (const i of r.Properties.SecurityGroupIngress ?? []) {
        rules.push({ group: groupId(id), port: i.FromPort, cidr: i.CidrIp, sourceGroup: refOf(i.SourceSecurityGroupId), prefixList: i.SourcePrefixListId });
      }
    }
    if (r.Type === 'AWS::EC2::SecurityGroupIngress') {
      const p = r.Properties;
      rules.push({ group: refOf(p.GroupId)!, port: p.FromPort, cidr: p.CidrIp, sourceGroup: refOf(p.SourceSecurityGroupId), prefixList: p.SourcePrefixListId });
    }
  }
  return rules;
};
const isWeb = (g: string) => g.startsWith('WebSecurityGroup');
const isLb = (g: string) => g.startsWith('LBSecurityGroup');
const listeners = (t: Template) => Object.values(t.findResources('AWS::ElasticLoadBalancingV2::Listener')) as any[];

const CLOUDFLARE = readCidrsFile('config/cloudflare-ips-v4.json');

describe('web instances (always on)', () => {
  const t = synth();
  test('the web security group admits port 80 from the load balancer and nothing else', () => {
    const web = ingress(t).filter((r) => isWeb(r.group));
    expect(web).toEqual([{ group: expect.stringMatching(/^WebSecurityGroup/), port: 80, sourceGroup: expect.stringMatching(/^LBSecurityGroup/), cidr: undefined, prefixList: undefined }]);
  });
  test('no security group in the stack admits SSH', () => {
    expect(ingress(t).filter((r) => r.port === 22)).toEqual([]);
  });
  test('turning SSH on requires an explicit range', () => {
    expect(() => stack({}, { enableSSHAccess: true })).toThrow(/sshAllowedIpRange/);
  });
});

describe('flags off', () => {
  const t = synth();
  test('the load balancer still takes 80 and 443 from anywhere', () => {
    const lb = ingress(t).filter((r) => isLb(r.group));
    expect(lb.map((r) => [r.port, r.cidr])).toEqual([[80, '0.0.0.0/0'], [443, '0.0.0.0/0']]);
  });
  test('both listeners forward by default and carry no rules', () => {
    for (const l of listeners(t)) expect(l.Properties.DefaultActions[0].Type).toBe('forward');
    t.resourceCountIs('AWS::ElasticLoadBalancingV2::ListenerRule', 0);
  });
  test('explicit false equals no flag', () => {
    expect(synth({ [RESTRICT_ALB_INGRESS_CONTEXT]: 'false', [REQUIRE_ORIGIN_HEADER_CONTEXT]: 'false' }).toJSON())
      .toEqual(t.toJSON());
  });
  test('a source given without the flag changes nothing', () => {
    expect(synth({ [ALB_INGRESS_CIDRS_FILE_CONTEXT]: 'config/cloudflare-ips-v4.json' }).toJSON()).toEqual(t.toJSON());
  });
});

describe(`${RESTRICT_ALB_INGRESS_CONTEXT}`, () => {
  test('from a CIDR file: exactly the listed ranges on 80 and 443, nothing from anywhere', () => {
    const t = synth({ [RESTRICT_ALB_INGRESS_CONTEXT]: 'true', [ALB_INGRESS_CIDRS_FILE_CONTEXT]: 'config/cloudflare-ips-v4.json' });
    const lb = ingress(t).filter((r) => isLb(r.group));
    expect(lb).toHaveLength(CLOUDFLARE.length * 2);
    for (const port of [80, 443]) {
      expect(lb.filter((r) => r.port === port).map((r) => r.cidr).sort()).toEqual([...CLOUDFLARE].sort());
    }
    expect(ingress(t).filter((r) => r.cidr === '0.0.0.0/0')).toEqual([]);
    // The web group is unchanged by the flag.
    expect(ingress(t).filter((r) => isWeb(r.group))).toEqual(ingress(synth()).filter((r) => isWeb(r.group)));
  });
  test('from a prefix list: one rule per port', () => {
    const t = synth({ [RESTRICT_ALB_INGRESS_CONTEXT]: true, [ALB_INGRESS_PREFIX_LIST_CONTEXT]: 'pl-0123456789abcdef0' });
    const lb = ingress(t).filter((r) => isLb(r.group));
    expect(lb.map((r) => [r.port, r.prefixList, r.cidr])).toEqual([
      [80, 'pl-0123456789abcdef0', undefined], [443, 'pl-0123456789abcdef0', undefined],
    ]);
  });
  test('inline ranges', () => {
    const t = synth({ [RESTRICT_ALB_INGRESS_CONTEXT]: 'true', [ALB_INGRESS_CIDRS_CONTEXT]: '198.51.100.0/24, 203.0.113.0/24' });
    expect(ingress(t).filter((r) => isLb(r.group)).map((r) => `${r.port} ${r.cidr}`)).toEqual([
      '80 198.51.100.0/24', '80 203.0.113.0/24', '443 198.51.100.0/24', '443 203.0.113.0/24',
    ]);
  });
  test('refuses no source, two sources, a /0 range and too many rules', () => {
    const on = { [RESTRICT_ALB_INGRESS_CONTEXT]: 'true' };
    expect(() => synth(on)).toThrow(/exactly one/);
    expect(() => synth({ ...on, [ALB_INGRESS_PREFIX_LIST_CONTEXT]: 'pl-0123456789abcdef0', [ALB_INGRESS_CIDRS_CONTEXT]: '198.51.100.0/24' })).toThrow(/exactly one/);
    expect(() => synth({ ...on, [ALB_INGRESS_CIDRS_CONTEXT]: '0.0.0.0/0' })).toThrow(/every address/);
    expect(() => synth({ ...on, [ALB_INGRESS_PREFIX_LIST_CONTEXT]: 'sg-123' })).toThrow(/prefix list/);
    const many = Array.from({ length: 31 }, (_, i) => `10.${i}.0.0/16`).join(',');
    expect(() => synth({ ...on, [ALB_INGRESS_CIDRS_CONTEXT]: many })).toThrow(/quota/);
  });
  test('CIDR validation', () => {
    expect(validateIpv4Cidr('104.16.0.0/13')).toBe('104.16.0.0/13');
    for (const bad of ['104.16.0.0', '300.1.1.1/8', '1.2.3.4/33', '2400:cb00::/32']) expect(() => validateIpv4Cidr(bad)).toThrow();
  });
});

describe(`${REQUIRE_ORIGIN_HEADER_CONTEXT}`, () => {
  const on = { [REQUIRE_ORIGIN_HEADER_CONTEXT]: 'true', [ORIGIN_HEADER_SECRET_CONTEXT]: 'polis/origin-header' };
  test('both listeners answer 403 by default and forward only with the header', () => {
    const t = synth(on);
    const ls = listeners(t);
    expect(ls).toHaveLength(2);
    for (const l of ls) {
      expect(l.Properties.DefaultActions).toEqual([{
        Type: 'fixed-response',
        FixedResponseConfig: { StatusCode: '403', ContentType: 'text/plain', MessageBody: 'Forbidden' },
      }]);
    }
    const rules = Object.values(t.findResources('AWS::ElasticLoadBalancingV2::ListenerRule')) as any[];
    expect(rules).toHaveLength(2);
    for (const r of rules) {
      expect(r.Properties.Priority).toBe(1);
      expect(r.Properties.Actions[0].Type).toBe('forward');
      expect(r.Properties.Conditions).toEqual([{
        Field: 'http-header',
        HttpHeaderConfig: {
          HttpHeaderName: DEFAULT_ORIGIN_HEADER_NAME,
          Values: ['{{resolve:secretsmanager:polis/origin-header:SecretString:::}}'],
        },
      }]);
    }
  });
  test('it does not change who can reach the load balancer', () => {
    const lb = ingress(synth(on)).filter((r) => isLb(r.group));
    expect(lb.map((r) => [r.port, r.cidr])).toEqual([[80, '0.0.0.0/0'], [443, '0.0.0.0/0']]);
  });
  test('header name is configurable; the secret name is required', () => {
    const t = synth({ ...on, [ORIGIN_HEADER_NAME_CONTEXT]: 'X-Other' });
    expect(JSON.stringify(t.findResources('AWS::ElasticLoadBalancingV2::ListenerRule'))).toContain('"X-Other"');
    expect(() => synth({ [REQUIRE_ORIGIN_HEADER_CONTEXT]: 'true' })).toThrow(/originHeaderSecretName/);
  });
  test('both flags together', () => {
    const t = synth({ ...on, [RESTRICT_ALB_INGRESS_CONTEXT]: 'true', [ALB_INGRESS_PREFIX_LIST_CONTEXT]: 'pl-0123456789abcdef0' });
    t.resourceCountIs('AWS::ElasticLoadBalancingV2::ListenerRule', 2);
    expect(ingress(t).filter((r) => r.cidr === '0.0.0.0/0')).toEqual([]);
  });
});

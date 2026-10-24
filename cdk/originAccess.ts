import * as fs from 'fs';
import * as path from 'path';
import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import { Construct } from 'constructs';

// Who may reach the load balancer, and what it requires of them.
//
// Both controls are OFF by default: without these context keys the load
// balancer accepts 80/443 from anywhere and forwards every request, exactly
// as before. They exist so that only the CDN in front of the site can reach
// the origin. Turn them on in this order (cdk/README.md, "Closing the origin"):
//   1. create the origin secret and the CDN rule that sends it as a header;
//   2. deploy with `-c requireOriginHeader=true -c originHeaderSecretName=...`;
//   3. deploy with `-c restrictAlbIngress=true` and one ingress source.
// Turning on step 2 before the CDN sends the header answers every request
// with 403.

export const RESTRICT_ALB_INGRESS_CONTEXT = 'restrictAlbIngress';
// One of these three names the allowed sources when the restriction is on.
export const ALB_INGRESS_PREFIX_LIST_CONTEXT = 'albIngressPrefixListId';
export const ALB_INGRESS_CIDRS_FILE_CONTEXT = 'albIngressCidrsFile';
export const ALB_INGRESS_CIDRS_CONTEXT = 'albIngressCidrs';

export const REQUIRE_ORIGIN_HEADER_CONTEXT = 'requireOriginHeader';
export const ORIGIN_HEADER_SECRET_CONTEXT = 'originHeaderSecretName';
export const ORIGIN_HEADER_SECRET_VERSION_CONTEXT = 'originHeaderSecretVersionId';
export const ORIGIN_HEADER_NAME_CONTEXT = 'originHeaderName';
export const DEFAULT_ORIGIN_HEADER_NAME = 'X-Polis-Origin-Auth';

// The ports the load balancer listens on. Both stay reachable from the CDN:
// which one it uses depends on the CDN's TLS mode.
export const ALB_PORTS = [80, 443];
// The default per-group inbound rule quota. Each CIDR costs one rule per port.
const MAX_INGRESS_RULES = 60;

const flag = (scope: Construct, key: string): boolean => {
  const v = scope.node.tryGetContext(key);
  return v === true || v === 'true';
};

const str = (scope: Construct, key: string): string | undefined => {
  const v = scope.node.tryGetContext(key);
  if (v === undefined || v === null || v === '') return undefined;
  if (typeof v !== 'string') throw new Error(`-c ${key} must be a string`);
  return v.trim();
};

export const restrictAlbIngressEnabled = (scope: Construct) => flag(scope, RESTRICT_ALB_INGRESS_CONTEXT);
export const requireOriginHeaderEnabled = (scope: Construct) => flag(scope, REQUIRE_ORIGIN_HEADER_CONTEXT);

export type AlbIngressSource =
  | { kind: 'prefixList'; prefixListId: string }
  | { kind: 'cidrs'; cidrs: string[] };

const IPV4_CIDR = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\/(\d{1,2})$/;

export const validateIpv4Cidr = (cidr: string): string => {
  const m = IPV4_CIDR.exec(cidr);
  if (!m || m.slice(1, 5).some((o) => Number(o) > 255) || Number(m[5]) > 32) {
    throw new Error(`not an IPv4 CIDR: '${cidr}'`);
  }
  if (Number(m[5]) === 0) {
    throw new Error(`'${cidr}' allows every address; the restriction would be a no-op`);
  }
  return cidr;
};

const parseCidrList = (raw: unknown, where: string): string[] => {
  const list = Array.isArray(raw)
    ? raw
    : typeof raw === 'string'
      ? raw.split(',')
      : undefined;
  if (!list) throw new Error(`${where}: expected a list of IPv4 CIDRs`);
  const cidrs = list.map((c) => String(c).trim()).filter(Boolean).map(validateIpv4Cidr);
  if (cidrs.length === 0) throw new Error(`${where}: the list of IPv4 CIDRs is empty`);
  return [...new Set(cidrs)];
};

// Reads a JSON file holding either an array of CIDRs or an object with a
// `cidrs` array (other keys, such as where the list came from, are ignored).
// A relative path is resolved against the cdk/ directory.
export const readCidrsFile = (file: string): string[] => {
  const resolved = path.resolve(__dirname, file);
  const parsed = JSON.parse(fs.readFileSync(resolved, 'utf8'));
  return parseCidrList(Array.isArray(parsed) ? parsed : parsed?.cidrs, resolved);
};

export const albIngressSource = (scope: Construct): AlbIngressSource => {
  const prefixList = str(scope, ALB_INGRESS_PREFIX_LIST_CONTEXT);
  const file = str(scope, ALB_INGRESS_CIDRS_FILE_CONTEXT);
  const inline = scope.node.tryGetContext(ALB_INGRESS_CIDRS_CONTEXT);
  const given = [prefixList, file, inline].filter((v) => v !== undefined && v !== '');
  if (given.length !== 1) {
    throw new Error(
      `-c ${RESTRICT_ALB_INGRESS_CONTEXT}=true needs exactly one of -c ${ALB_INGRESS_PREFIX_LIST_CONTEXT}=pl-..., ` +
      `-c ${ALB_INGRESS_CIDRS_FILE_CONTEXT}=<json file> or -c ${ALB_INGRESS_CIDRS_CONTEXT}=<cidr,cidr,...> ` +
      `(got ${given.length})`);
  }
  if (prefixList !== undefined) {
    if (!/^pl-[0-9a-f]{8,17}$/.test(prefixList)) {
      throw new Error(`-c ${ALB_INGRESS_PREFIX_LIST_CONTEXT}: not a prefix list id: '${prefixList}'`);
    }
    return { kind: 'prefixList', prefixListId: prefixList };
  }
  const cidrs = file !== undefined ? readCidrsFile(file) : parseCidrList(inline, `-c ${ALB_INGRESS_CIDRS_CONTEXT}`);
  if (cidrs.length * ALB_PORTS.length > MAX_INGRESS_RULES) {
    throw new Error(
      `${cidrs.length} CIDRs x ${ALB_PORTS.length} ports exceeds the ${MAX_INGRESS_RULES}-rule security group ` +
      `quota; use a managed prefix list (-c ${ALB_INGRESS_PREFIX_LIST_CONTEXT}) instead`);
  }
  return { kind: 'cidrs', cidrs };
};

// Adds the load balancer's inbound rules. Returns whether the listeners may
// still open themselves to the world (`open: true`), which is the case only
// when the restriction is off.
export const configureAlbIngress = (scope: Construct, lbSecurityGroup: ec2.SecurityGroup): { openListeners: boolean } => {
  if (!restrictAlbIngressEnabled(scope)) {
    lbSecurityGroup.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(80), 'Allow HTTP from anywhere');
    lbSecurityGroup.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(443), 'Allow HTTPS from anywhere');
    return { openListeners: true };
  }
  const source = albIngressSource(scope);
  const peers: Array<{ peer: ec2.IPeer; label: string }> = source.kind === 'prefixList'
    ? [{ peer: ec2.Peer.prefixList(source.prefixListId), label: `prefix list ${source.prefixListId}` }]
    : source.cidrs.map((c) => ({ peer: ec2.Peer.ipv4(c), label: c }));
  for (const port of ALB_PORTS) {
    for (const { peer, label } of peers) {
      lbSecurityGroup.addIngressRule(peer, ec2.Port.tcp(port), `Allow ${port} from the CDN (${label})`);
    }
  }
  return { openListeners: false };
};

export interface OriginHeader {
  name: string;
  // A CloudFormation dynamic reference to the secret; the value itself never
  // appears in the repository or the synthesized template.
  value: string;
}

export const originHeader = (scope: Construct): OriginHeader | undefined => {
  if (!requireOriginHeaderEnabled(scope)) return undefined;
  const secretName = str(scope, ORIGIN_HEADER_SECRET_CONTEXT);
  if (!secretName) {
    throw new Error(
      `-c ${REQUIRE_ORIGIN_HEADER_CONTEXT}=true needs -c ${ORIGIN_HEADER_SECRET_CONTEXT}=<Secrets Manager secret name>`);
  }
  const name = str(scope, ORIGIN_HEADER_NAME_CONTEXT) ?? DEFAULT_ORIGIN_HEADER_NAME;
  if (!/^[A-Za-z0-9-]{1,40}$/.test(name)) {
    throw new Error(`-c ${ORIGIN_HEADER_NAME_CONTEXT}: not a plain header name: '${name}'`);
  }
  const versionId = str(scope, ORIGIN_HEADER_SECRET_VERSION_CONTEXT);
  const value = cdk.SecretValue.secretsManager(secretName, versionId ? { versionId } : {}).unsafeUnwrap();
  return { name, value };
};

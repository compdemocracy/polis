import type { Request } from "express";
import { BlockList, isIP } from "node:net";

// Kept identical to cdk/config/cloudflare-ips-v4.json by the endpoint tests.
// These are the IPv4 edges allowed to reach the production load balancer.
export const clientErrorProxyRanges = [
  "173.245.48.0/20",
  "103.21.244.0/22",
  "103.22.200.0/22",
  "103.31.4.0/22",
  "141.101.64.0/18",
  "108.162.192.0/18",
  "190.93.240.0/20",
  "188.114.96.0/20",
  "197.234.240.0/22",
  "198.41.128.0/17",
  "162.158.0.0/15",
  "104.16.0.0/13",
  "104.24.0.0/14",
  "172.64.0.0/13",
  "131.0.72.0/22",
];
const edges = new BlockList();
for (const range of clientErrorProxyRanges) {
  const [network, prefix] = range.split("/");
  edges.addSubnet(network, Number(prefix), "ipv4");
}

function canonical(address: string): string {
  if (isIP(address) === 6) {
    const unscoped = address.split("%")[0];
    const value = new URL(`http://[${unscoped}]/`).hostname.slice(1, -1);
    // IPv4-mapped IPv6 has the same budget as the corresponding IPv4 address.
    if (value.startsWith("::ffff:")) {
      const parts = value
        .slice(7)
        .split(":")
        .map((x) => parseInt(x, 16));
      if (parts.length === 2)
        return [
          parts[0] >> 8,
          parts[0] & 255,
          parts[1] >> 8,
          parts[1] & 255,
        ].join(".");
    }
    const [left, right = ""] = value.split("::");
    const head = left ? left.split(":") : [];
    const tail = right ? right.split(":") : [];
    const parts = value.includes("::")
      ? [...head, ...Array(8 - head.length - tail.length).fill("0"), ...tail]
      : head;
    return parts.slice(0, 4).join(":") + "::/64";
  }
  return address;
}

export function clientErrorAddress(req: Request): string {
  const hop = canonical(req.ip || req.socket.remoteAddress || "unknown");
  const forwarded = req.headers["x-forwarded-for"];
  if (
    typeof forwarded !== "string" ||
    forwarded.length > 2048 ||
    isIP(hop) !== 4 ||
    !edges.check(hop, "ipv4")
  )
    return hop;
  const last = forwarded.lastIndexOf(",");
  if (last < 0 || canonical(forwarded.slice(last + 1).trim()) !== hop)
    return hop;
  // ALB appends the edge; Cloudflare appends its observed client before that.
  // Earlier entries are client supplied. Reuse this rightmost-pair derivation
  // from the nginx access log, never the leftmost forwarded value.
  const before = forwarded.slice(0, last);
  const participant = before.slice(before.lastIndexOf(",") + 1).trim();
  return isIP(participant) ? canonical(participant) : hop;
}

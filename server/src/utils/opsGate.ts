// The access decision for the protected operations pages (/api/v3/ops/*).
//
// Pure functions only: no Express, no Config, no I/O. The route module
// (src/routes/ops.ts) feeds them the validated OIDC access-token payload and
// the parsed OPS_EMAIL_DOMAINS list, and these functions answer allow or a
// closed reason code. Every unknown or missing input is a refusal.
//
// OPS_EMAIL_DOMAINS grammar (comma-separated; whitespace around an entry is
// trimmed; entries are lower-cased; empty entries between commas are ignored):
//
//   compdemocracy.org          a domain: the verified email's domain part,
//                              taken after the single "@", equals it exactly
//                              (never a suffix test, so evilcompdemocracy.org
//                              and compdemocracy.org.example.com do not match)
//   someone@example.org        an address: the verified email equals it exactly
//   !former@compdemocracy.org  a deny entry (domain or address); a deny match
//                              wins over every allow entry
//
// Anything else is malformed and stops the server at startup when OPS_ENABLED
// is true: an "@" in a domain position, more than one "@", whitespace inside an
// entry, a "*", a domain without a dot, an empty or dotted-edge label.

export type OpsEntryKind = "domain" | "address";

export type OpsEntry = {
  kind: OpsEntryKind;
  value: string;
};

export type OpsEmailPolicy = {
  allow: OpsEntry[];
  deny: OpsEntry[];
};

// The login connection strategies that may carry ops access. A password login
// (Auth0 strategy "auth0") never does, even for an allowed address.
export const OPS_CONNECTION_STRATEGIES: readonly string[] = ["google-oauth2"];

export type OpsRefusal =
  | "connection_missing"
  | "connection_not_allowed"
  | "email_unverified"
  | "email_missing"
  | "email_malformed"
  | "email_denied"
  | "email_not_allowed"
  | "hd_mismatch"
  | "namespace_unset";

export type OpsDecision =
  | { ok: true; reason?: undefined }
  | { ok: false; reason: OpsRefusal };

export class OpsConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OpsConfigError";
  }
}

// One DNS label: letters, digits and inner hyphens. Punycode (xn--) passes.
const LABEL = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;

function isDomain(value: string): boolean {
  if (value.length === 0 || value.length > 253) return false;
  const labels = value.split(".");
  if (labels.length < 2) return false;
  return labels.every((label) => label.length <= 63 && LABEL.test(label));
}

// The local part is compared byte for byte, so it only has to be non-empty
// and free of whitespace, "@" and "*".
function isLocalPart(value: string): boolean {
  return value.length > 0 && !/[\s@*,]/.test(value);
}

function parseEntry(raw: string): { deny: boolean; entry: OpsEntry } {
  const trimmed = raw.trim().toLowerCase();
  const deny = trimmed.startsWith("!");
  const body = deny ? trimmed.slice(1) : trimmed;
  const bad = (why: string) =>
    new OpsConfigError(
      `polis_err_ops_email_domains_malformed: entry "${raw.trim()}" ${why}`
    );
  if (body.length === 0) throw bad("is empty after its prefix");
  if (/\s/.test(body)) throw bad("contains whitespace");
  if (body.includes("*"))
    throw bad("contains a wildcard; list domains exactly");
  if (body.includes("!"))
    throw bad("has a '!' that is not its first character");
  const ats = body.split("@").length - 1;
  if (ats === 0) {
    if (!isDomain(body)) throw bad("is not a domain such as example.org");
    return { deny, entry: { kind: "domain", value: body } };
  }
  if (ats > 1) throw bad("has more than one '@'");
  const [local, domain] = body.split("@");
  if (local.length === 0)
    throw bad("starts with '@'; write the domain without it");
  if (!isLocalPart(local) || !isDomain(domain))
    throw bad("is not an address such as someone@example.org");
  return { deny, entry: { kind: "address", value: body } };
}

/**
 * Parse OPS_EMAIL_DOMAINS. Throws OpsConfigError naming the first malformed
 * entry, or when there is no allow entry at all (a deny-only list admits
 * nobody, which is never what an operator meant by switching ops on).
 *
 * `devMode` gates the local test domain: an allow entry on polis.test is
 * refused unless DEV_MODE=true, so a copied local config cannot open a
 * production deployment to the simulator's accounts.
 */
export function parseOpsEmailDomains(
  raw: string | null | undefined,
  devMode: boolean
): OpsEmailPolicy {
  const policy: OpsEmailPolicy = { allow: [], deny: [] };
  for (const piece of (raw || "").split(",")) {
    if (piece.trim().length === 0) continue;
    const { deny, entry } = parseEntry(piece);
    (deny ? policy.deny : policy.allow).push(entry);
  }
  if (policy.allow.length === 0) {
    throw new OpsConfigError(
      "polis_err_ops_email_domains_empty: OPS_ENABLED=true needs at least one allow entry in OPS_EMAIL_DOMAINS"
    );
  }
  if (!devMode) {
    const local = policy.allow.find((e) => domainOf(e) === "polis.test");
    if (local) {
      throw new OpsConfigError(
        `polis_err_ops_email_domains_dev_only: entry "${local.value}" is the local test domain and needs DEV_MODE=true`
      );
    }
  }
  return policy;
}

function domainOf(entry: OpsEntry): string {
  return entry.kind === "domain"
    ? entry.value
    : entry.value.slice(entry.value.indexOf("@") + 1);
}

/**
 * Split a claimed email into its parts, or null when it is not exactly one
 * non-empty local part and one well-formed domain.
 */
export function splitEmail(
  email: unknown
): { address: string; domain: string } | null {
  if (typeof email !== "string") return null;
  const address = email.trim().toLowerCase();
  if (address.split("@").length !== 2) return null;
  const [local, domain] = address.split("@");
  if (!isLocalPart(local) || !isDomain(domain)) return null;
  return { address, domain };
}

function matches(entry: OpsEntry, address: string, domain: string): boolean {
  return entry.kind === "domain"
    ? entry.value === domain
    : entry.value === address;
}

/**
 * The claim checks, in order. `payload` is the access-token payload that has
 * already passed signature, issuer and audience validation; `namespace` is
 * AUTH_NAMESPACE (for example "https://pol.is/").
 *
 *   1. connection_strategy present and in OPS_CONNECTION_STRATEGIES
 *      (absent: refused, so ops stays dark until the Auth0 Action emits it)
 *   2. email_verified === true (the boolean, not a truthy string)
 *   3. email well formed; no deny entry matches; some allow entry matches
 *   4. hd, when present, equals the email's domain part
 */
export function decideOps(
  payload: Record<string, unknown> | null | undefined,
  namespace: string | null | undefined,
  policy: OpsEmailPolicy
): OpsDecision {
  if (!namespace) return { ok: false, reason: "namespace_unset" };
  const claims = payload || {};
  const claim = (name: string) => claims[`${namespace}${name}`];

  const strategy = claim("connection_strategy");
  if (typeof strategy !== "string" || strategy.length === 0) {
    return { ok: false, reason: "connection_missing" };
  }
  if (!OPS_CONNECTION_STRATEGIES.includes(strategy)) {
    return { ok: false, reason: "connection_not_allowed" };
  }

  if (claim("email_verified") !== true) {
    return { ok: false, reason: "email_unverified" };
  }
  const rawEmail = claim("email");
  if (rawEmail === undefined || rawEmail === null || rawEmail === "") {
    return { ok: false, reason: "email_missing" };
  }
  const email = splitEmail(rawEmail);
  if (!email) return { ok: false, reason: "email_malformed" };

  if (policy.deny.some((e) => matches(e, email.address, email.domain))) {
    return { ok: false, reason: "email_denied" };
  }
  if (!policy.allow.some((e) => matches(e, email.address, email.domain))) {
    return { ok: false, reason: "email_not_allowed" };
  }

  const hd = claim("hd");
  if (hd !== undefined && hd !== null) {
    if (typeof hd !== "string" || hd.trim().toLowerCase() !== email.domain) {
      return { ok: false, reason: "hd_mismatch" };
    }
  }
  return { ok: true };
}

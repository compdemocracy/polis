import { describe, expect, test } from "@jest/globals";
import {
  decideOps,
  OpsConfigError,
  parseOpsEmailDomains,
  splitEmail,
} from "../../src/utils/opsGate";

// Generated fixtures only: example domains and made-up addresses.
const NS = "https://pol.is/";

function claims(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    sub: "google-oauth2|100000000000000000001",
    [`${NS}connection_strategy`]: "google-oauth2",
    [`${NS}email`]: "staff.one@example.org",
    [`${NS}email_verified`]: true,
    ...over,
  };
}

const ns = (name: string) => `${NS}${name}`;

describe("parseOpsEmailDomains", () => {
  test("domains, addresses and deny entries, trimmed and lower-cased", () => {
    const policy = parseOpsEmailDomains(
      " Example.ORG , collab@Example.com,!former@example.org ,, ",
      false
    );
    expect(policy.allow).toEqual([
      { kind: "domain", value: "example.org" },
      { kind: "address", value: "collab@example.com" },
    ]);
    expect(policy.deny).toEqual([
      { kind: "address", value: "former@example.org" },
    ]);
  });

  test("a deny entry may be a whole domain", () => {
    const policy = parseOpsEmailDomains(
      "example.org,!contractors.example.org",
      false
    );
    expect(policy.deny).toEqual([
      { kind: "domain", value: "contractors.example.org" },
    ]);
  });

  test.each([
    ["", "polis_err_ops_email_domains_empty"],
    [" , ,", "polis_err_ops_email_domains_empty"],
    ["!former@example.org", "polis_err_ops_email_domains_empty"],
  ])("no allow entry (%p) is refused", (raw, code) => {
    expect(() => parseOpsEmailDomains(raw, false)).toThrow(OpsConfigError);
    expect(() => parseOpsEmailDomains(raw, false)).toThrow(code);
  });

  test("undefined and null are an empty list", () => {
    expect(() => parseOpsEmailDomains(undefined, false)).toThrow(
      "polis_err_ops_email_domains_empty"
    );
    expect(() => parseOpsEmailDomains(null, false)).toThrow(
      "polis_err_ops_email_domains_empty"
    );
  });

  test.each([
    "*.example.org",
    "*@example.org",
    "example",
    "@example.org",
    "a@b@example.org",
    "exa mple.org",
    "example..org",
    ".example.org",
    "example.org.",
    "-example.org",
    "!",
    "!!example.org",
    "someone@",
    "someone@localhost",
  ])("malformed entry %p stops startup with the entry named", (entry) => {
    expect(() => parseOpsEmailDomains(`example.org,${entry}`, false)).toThrow(
      "polis_err_ops_email_domains_malformed"
    );
    expect(() => parseOpsEmailDomains(`example.org,${entry}`, false)).toThrow(
      entry.trim()
    );
  });

  test("the local test domain needs DEV_MODE", () => {
    expect(() => parseOpsEmailDomains("polis.test", false)).toThrow(
      "polis_err_ops_email_domains_dev_only"
    );
    expect(() => parseOpsEmailDomains("admin@polis.test", false)).toThrow(
      "polis_err_ops_email_domains_dev_only"
    );
    expect(parseOpsEmailDomains("polis.test", true).allow).toEqual([
      { kind: "domain", value: "polis.test" },
    ]);
    // A deny entry on the test domain admits nobody, so it is not refused.
    expect(
      parseOpsEmailDomains("example.org,!moderator@polis.test", false).deny
    ).toHaveLength(1);
  });
});

describe("splitEmail", () => {
  test.each([
    [
      "Staff.One@Example.ORG",
      { address: "staff.one@example.org", domain: "example.org" },
    ],
    [
      " staff@example.org ",
      { address: "staff@example.org", domain: "example.org" },
    ],
  ])("%p", (email, expected) => {
    expect(splitEmail(email)).toEqual(expected);
  });

  test.each([
    undefined,
    null,
    42,
    "",
    "no-at-sign",
    "a@b@example.org",
    "@example.org",
    "a@example",
    "a b@example.org",
  ])("rejects %p", (email) => {
    expect(splitEmail(email)).toBeNull();
  });
});

describe("decideOps", () => {
  const domain = parseOpsEmailDomains("example.org", false);

  test("a verified Google login on an allowed domain passes", () => {
    expect(decideOps(claims(), NS, domain)).toEqual({ ok: true });
  });

  test("fails closed until the connection claim exists", () => {
    const c = claims();
    delete c[ns("connection_strategy")];
    expect(decideOps(c, NS, domain)).toEqual({
      ok: false,
      reason: "connection_missing",
    });
    expect(
      decideOps(claims({ [ns("connection_strategy")]: "" }), NS, domain)
    ).toEqual({
      ok: false,
      reason: "connection_missing",
    });
  });

  test("a password login is refused even for an allowed address", () => {
    expect(
      decideOps(claims({ [ns("connection_strategy")]: "auth0" }), NS, domain)
    ).toEqual({
      ok: false,
      reason: "connection_not_allowed",
    });
  });

  test("a non-namespaced connection claim is not read", () => {
    const c = claims({ connection_strategy: "google-oauth2" });
    delete c[ns("connection_strategy")];
    expect(decideOps(c, NS, domain)).toEqual({
      ok: false,
      reason: "connection_missing",
    });
  });

  test.each([false, "true", 1, undefined, null])(
    "email_verified %p is refused",
    (verified) => {
      expect(
        decideOps(claims({ [ns("email_verified")]: verified }), NS, domain)
      ).toEqual({
        ok: false,
        reason: "email_unverified",
      });
    }
  );

  test("the standard (non-namespaced) email claims are not read", () => {
    const c = claims({ email: "staff.one@example.org", email_verified: true });
    delete c[ns("email")];
    expect(decideOps(c, NS, domain)).toEqual({
      ok: false,
      reason: "email_missing",
    });
  });

  test("a malformed email is refused", () => {
    expect(
      decideOps(claims({ [ns("email")]: "a@b@example.org" }), NS, domain)
    ).toEqual({
      ok: false,
      reason: "email_malformed",
    });
  });

  test.each([
    "someone@evilexample.org",
    "someone@example.org.example.com",
    "someone@sub.example.org",
    "someone@example.organic",
    "example.org@example.com",
  ])("lookalike %p does not match the domain entry", (email) => {
    expect(decideOps(claims({ [ns("email")]: email }), NS, domain)).toEqual({
      ok: false,
      reason: "email_not_allowed",
    });
  });

  test("matching is case-insensitive", () => {
    expect(
      decideOps(claims({ [ns("email")]: "Staff.One@EXAMPLE.org" }), NS, domain)
    ).toEqual({
      ok: true,
    });
  });

  describe("address entries", () => {
    const policy = parseOpsEmailDomains(
      "example.org,collab@example.com",
      false
    );

    test("the listed address passes", () => {
      expect(
        decideOps(claims({ [ns("email")]: "collab@example.com" }), NS, policy)
      ).toEqual({
        ok: true,
      });
    });

    test("another address on the same domain does not", () => {
      expect(
        decideOps(claims({ [ns("email")]: "other@example.com" }), NS, policy)
      ).toEqual({
        ok: false,
        reason: "email_not_allowed",
      });
    });
  });

  describe("deny entries win", () => {
    const policy = parseOpsEmailDomains(
      "example.org,former@example.org,!former@example.org,!contractors.example.net,contractors.example.net",
      false
    );

    test("a denied address is refused although its domain and address are allowed", () => {
      expect(
        decideOps(claims({ [ns("email")]: "former@example.org" }), NS, policy)
      ).toEqual({
        ok: false,
        reason: "email_denied",
      });
    });

    test("a denied domain is refused although it is also allowed", () => {
      expect(
        decideOps(
          claims({ [ns("email")]: "a@contractors.example.net" }),
          NS,
          policy
        )
      ).toEqual({ ok: false, reason: "email_denied" });
    });

    test("everyone else on the domain still passes", () => {
      expect(
        decideOps(
          claims({ [ns("email")]: "staff.two@example.org" }),
          NS,
          policy
        )
      ).toEqual({
        ok: true,
      });
    });
  });

  describe("hd", () => {
    test("absent hd is accepted", () => {
      expect(decideOps(claims(), NS, domain)).toEqual({ ok: true });
    });

    test("hd equal to the email domain passes, in any case", () => {
      expect(
        decideOps(claims({ [ns("hd")]: "Example.org" }), NS, domain)
      ).toEqual({ ok: true });
    });

    test.each(["example.com", "", 7])("hd %p that differs is refused", (hd) => {
      expect(decideOps(claims({ [ns("hd")]: hd }), NS, domain)).toEqual({
        ok: false,
        reason: "hd_mismatch",
      });
    });
  });

  test("no namespace configured refuses everything", () => {
    expect(decideOps(claims(), null, domain)).toEqual({
      ok: false,
      reason: "namespace_unset",
    });
    expect(decideOps(claims(), "", domain)).toEqual({
      ok: false,
      reason: "namespace_unset",
    });
  });

  test("a missing payload is refused", () => {
    expect(decideOps(undefined, NS, domain)).toEqual({
      ok: false,
      reason: "connection_missing",
    });
  });
});

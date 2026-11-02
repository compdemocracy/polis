import fs from "node:fs";
import path from "node:path";
import jwt from "jsonwebtoken";
import { createPublicKey } from "node:crypto";

const { applyProfile } = require("../../characterization/identity/policy.cjs");
const { cases } = require("../../characterization/identity/cases.cjs");
const { firstDifference } = require("../../characterization/compare.cjs");
const { bytes, strings } = require("../../characterization/wire.cjs");
const fixture = JSON.parse(
  fs.readFileSync(
    path.join(__dirname, "../fixtures/identity/recordings.json"),
    "utf8"
  )
);
applyProfile(fixture.comparison);
const copy = (value: any) => JSON.parse(JSON.stringify(value));

it("contains the complete generated identity case inventory and no signing key", () => {
  expect(fixture.format).toBe("identity-recordings/2");
  expect(fixture.recordings.map((r: any) => r.case)).toEqual(
    cases.map((c: any) => c.name)
  );
  expect(fixture.evidence.map((r: any) => r.case)).toEqual(
    cases.map((c: any) => c.name)
  );
  expect(new Set(cases.map((c: any) => c.name)).size).toBe(cases.length);
  expect(fixture.cases).toBe(cases.length);
  expect(JSON.stringify(fixture)).not.toMatch(/BEGIN (?:RSA )?PRIVATE KEY/);
});

it.each(cases)(
  "the committed identity fixture is internally consistent: $name",
  (spec: any) => {
    const r = fixture.recordings.find((r: any) => r.case === spec.name);
    const e = fixture.evidence.find((r: any) => r.case === spec.name);
    const raw = Buffer.from(e.raw.body_base64, "base64");
    const isJson = e.raw.headers["content-type"]?.includes("application/json");
    const body = isJson ? JSON.parse(raw.toString()) : raw.toString();
    expect(e.raw.status).toBe(spec.status);
    expect(r.response.status).toBe(spec.status);
    expect(r.oracle).toEqual({ ...r.oracle, pass: true, failures: [] });
    expect(Number(e.raw.headers["content-length"])).toBe(raw.length);
    if (isJson)
      expect(require("express/lib/utils").wetag(raw)).toBe(e.raw.headers.etag);
    expect(e.raw.fault).toEqual({
      armed: null,
      fired: spec.fault === "load" ? 4 : spec.fault ? 1 : 0,
    });
    for (const [key, table] of [
      ["users", "users"],
      ["participants", "participants"],
      ["xids", "xids"],
      ["mappings", "oidc_user_mappings"],
    ]) {
      expect(e.after[table].length - e.before[table].length).toBe(
        spec[key] || 0
      );
      expect(e.proof[key]).toBe(spec[key] || 0);
    }
    if (body.user?.site_ids) {
      expect(body.user.site_ids).toEqual([
        e.after.users.find((u: any) => u.uid === body.user.uid).site_id,
      ]);
    }
    if (spec.name === "pc-xid") {
      expect(e.before.xids.some((x: any) => x.xid === spec.xid)).toBe(false);
      expect(e.after.xids.find((x: any) => x.xid === spec.xid).uid).toBe(
        (jwt.decode(body.auth.token) as any).uid
      );
    }
    if (["oidc-account", "oidc-extraction"].includes(spec.name))
      expect(body.details).toBeUndefined();
    if (spec.details) expect(body.details).toBe(spec.details);
    if (spec.error) expect(body.error).toBe(spec.error);
    if (spec.text) expect(body).toBe(spec.text);
    expect(!!body.auth).toBe(!!spec.token);
    if (spec.auth === "oidc-first") {
      const decoded: any = jwt.decode(e.credential, { complete: true });
      const jwk = fixture.provider_jwks.keys.find(
        (k: any) => k.kid === decoded.header.kid
      );
      expect(jwk).toBeDefined();
      const publicKey = createPublicKey({ key: jwk, format: "jwk" });
      const claims: any = jwt.verify(e.credential, publicKey, {
        algorithms: ["RS256"],
        issuer: "https://oidc-simulator:3000/",
        audience: "users",
        clockTimestamp: 1700000000,
      });
      expect(claims.sub).toBe("generated-identity-user");
    }
    if (spec.token) {
      const claims: any = jwt.verify(body.auth.token, fixture.public_key, {
        algorithms: ["RS256"],
        issuer: "https://pol.is/",
        audience: "participants",
        clockTimestamp: 1700000000,
      });
      expect(claims[spec.token + "_participant"]).toBe(true);
      expect(claims.exp - claims.iat).toBe(31536000);
      expect(claims.iat).toBe(1700000000);
      expect(claims.conversation_id).toBe(
        spec.zid ? `2p027identity${spec.zid}` : "2p027generated"
      );
      if (r.credentialBinding.actorUid !== undefined)
        expect(claims.uid).toBe(r.credentialBinding.actorUid);
      if (spec.users)
        expect(e.before.users.some((u: any) => u.uid === claims.uid)).toBe(
          false
        );
      expect(
        e.after.participants.some(
          (p: any) =>
            p.uid === claims.uid &&
            p.pid === claims.pid &&
            p.zid === (spec.zid || 1)
        )
      ).toBe(true);
      expect(body.auth.token_type).toBe("Bearer");
      expect(body.auth.expires_in).toBe(31536000);
      expect(r.effects.jwtIssued).toBe(1);
    }
    if (spec.route === "votes" && spec.status === 200) {
      const votes = r.effects.db["pg:votes"]?.added || [];
      expect(votes).toHaveLength(1);
      expect(votes[0].vote).toBe(fixture.storage_agree);
    }
    // The recorder only substitutes verified JWT values in its wire body. All
    // surrounding response bytes (including JSON order) must remain untouched.
    const substituted = isJson
      ? strings(raw.toString(), (value: string, _path: any, key: string) => {
          if (key !== "token" || !body.auth || value !== body.auth.token)
            return value;
          const wireBody = JSON.parse(bytes(r).toString());
          expect(wireBody.auth.token).toMatch(/^\$jwt:[a-f0-9]{64}$/);
          return wireBody.auth.token;
        })
      : raw.toString();
    expect(bytes(r).toString()).toBe(substituted);
  }
);

it("retains the orphan user and the unbound participant across the XID retry", () => {
  const tree = fixture.evidence.find(
    (e: any) => e.case === "treevite-refused-first-join"
  );
  const orphan = tree.after.users.find(
    (u: any) => !tree.before.users.some((b: any) => b.uid === u.uid)
  );
  expect(tree.after.participants.some((p: any) => p.uid === orphan.uid)).toBe(
    false
  );
  const failed = fixture.evidence.find(
    (e: any) => e.case === "xid-upsert-failure"
  );
  const retry = fixture.evidence.find(
    (e: any) => e.case === "xid-upsert-retry"
  );
  const unbound = failed.after.users.find(
    (u: any) => !failed.before.users.some((b: any) => b.uid === u.uid)
  );
  expect(
    failed.after.participants.some((p: any) => p.uid === unbound.uid)
  ).toBe(true);
  expect(retry.after.participants.some((p: any) => p.uid === unbound.uid)).toBe(
    true
  );
  expect(retry.after.xids.some((x: any) => x.uid === unbound.uid)).toBe(false);
  expect(
    retry.after.xids.find((x: any) => x.xid === "generated-retry-xid").uid
  ).not.toBe(unbound.uid);
});

it("reuses the first OIDC mapping and verifies the Treevite login credential", async () => {
  const first = fixture.evidence.find((e: any) => e.case === "oidc-first-use");
  const repeat = fixture.evidence.find((e: any) => e.case === "oidc-repeat");
  const mappings = first.after.oidc_user_mappings.filter(
    (m: any) => m.oidc_sub === "generated-identity-user"
  );
  expect(mappings).toHaveLength(1);
  expect(repeat.after.oidc_user_mappings).toEqual(
    first.after.oidc_user_mappings
  );
  expect(repeat.after.users).toEqual(first.after.users);
  const accept = fixture.evidence.find(
    (e: any) => e.case === "treevite-accept"
  );
  const login = fixture.evidence.find((e: any) => e.case === "treevite-login");
  const code = JSON.parse(
    Buffer.from(accept.raw.body_base64, "base64").toString()
  ).login_code;
  expect(
    await require("bcryptjs").compare(
      code,
      accept.after.treevite_login_codes[0].login_code_hash
    )
  ).toBe(true);
  expect(login.proof.treeviteCredentialVerified).toBe(true);
  expect(login.after.treevite_login_codes[0].last_used_at).not.toBeNull();
});

it.each(["status", "body-order", "database-row", "header"])(
  "detects a changed %s",
  (kind) => {
    const original = fixture.recordings[0];
    const changed = copy(original);
    if (kind === "status") changed.response.status++;
    if (kind === "database-row") changed.effects.db["pg:users"].added[0].uid++;
    if (kind === "header")
      changed.wire.response.headers.find(
        (h: any) => h.name.toLowerCase() === "content-type"
      ).value = "text/plain";
    if (kind === "body-order") {
      const text = bytes(changed).toString();
      const body = JSON.parse(text);
      const reversed = JSON.stringify(
        Object.fromEntries(Object.entries(body).reverse())
      );
      expect(reversed).not.toBe(text);
      changed.wire.response.body[0].bytes.base64 =
        Buffer.from(reversed).toString("base64");
    }
    expect(firstDifference(original, changed)).not.toBeNull();
  }
);

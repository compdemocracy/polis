import fs from "node:fs";
import { createHmac, generateKeyPairSync } from "node:crypto";
import path from "node:path";
import jwt from "jsonwebtoken";
import Config from "../../src/config";
import {
  createJwtValidation,
  issueParticipantJWT,
} from "../../src/auth/jwt-utils";

type Case = {
  kind: "anonymous" | "xid" | "standard_user";
  variant: string;
  claims: Record<string, any>;
  accepted: boolean;
  rust_token: string;
  node_token: string;
};
type Recording = {
  now: number;
  public_key: string;
  private_key?: string;
  cases: Case[];
};
const fixturePath = path.join(
  __dirname,
  "../fixtures/participant-jwt/recordings.json"
);
const inputPath = process.env.POLIS_JWT_RECORD_INPUT;
const recording: Recording = JSON.parse(
  fs.readFileSync(inputPath || fixturePath, "utf8")
);
const originalConfig = {
  jwtPrivateKey: Config.jwtPrivateKey,
  jwtPublicKey: Config.jwtPublicKey,
  polisJwtIssuer: Config.polisJwtIssuer,
  polisJwtAudience: Config.polisJwtAudience,
};
let verifiedCases = 0;

beforeAll(() => {
  Config.jwtPublicKey = recording.public_key;
  Config.polisJwtIssuer = "https://pol.is/";
  Config.polisJwtAudience = "participants";
  jest.spyOn(Date, "now").mockReturnValue(recording.now * 1000);
  const keys = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
  if (inputPath && !recording.private_key) {
    throw new Error("Missing generated test key");
  }
  Config.jwtPrivateKey = inputPath ? recording.private_key! : keys.privateKey;
  for (const kind of ["anonymous", "xid", "standard_user"] as const) {
    // Exercise the production minter on every run, with a disposable test key.
    const token =
      kind === "anonymous"
        ? issueParticipantJWT("anonymous", "2jwt-test", 3, 0)
        : kind === "xid"
        ? issueParticipantJWT("xid", "2jwt-test", 3, 0, "test-external-id")
        : issueParticipantJWT(
            "standard_user",
            "2jwt-test",
            3,
            0,
            "test|subject"
          );
    const base = recording.cases.find(
      (candidate) => candidate.kind === kind && candidate.variant === "valid"
    )!;
    const decoded = jwt.decode(token, { complete: true })!;
    expect(decoded.header).toEqual({ alg: "RS256", typ: "JWT" });
    expect(decoded.payload).toEqual(base.claims);
    expect(
      jwt.verify(token, inputPath ? recording.public_key : keys.publicKey, {
        algorithms: ["RS256"],
        issuer: Config.polisJwtIssuer,
        audience: Config.polisJwtAudience,
      })
    ).toEqual(base.claims);
    if (!inputPath) continue;
    for (const c of recording.cases.filter(
      (candidate) => candidate.kind === kind
    )) {
      if (c.variant === "unsigned_none" || c.variant === "hs256_public_key") {
        // jsonwebtoken 9 would sign HS256 with the public PEM too: it falls
        // back to using the PEM text as an HMAC secret. The token is built
        // here so the recording does not depend on that library behaviour.
        const header = Buffer.from(
          JSON.stringify({
            alg: c.variant === "unsigned_none" ? "none" : "HS256",
            typ: "JWT",
          })
        ).toString("base64url");
        const payload = Buffer.from(JSON.stringify(c.claims)).toString(
          "base64url"
        );
        const signingInput = `${header}.${payload}`;
        const signature =
          c.variant === "unsigned_none"
            ? ""
            : createHmac("sha256", recording.public_key)
                .update(signingInput)
                .digest("base64url");
        c.node_token = `${signingInput}.${signature}`;
      } else {
        c.node_token =
          c.variant === "valid"
            ? token
            : jwt.sign(c.claims, recording.private_key!, {
                algorithm: c.variant === "wrong_algorithm" ? "RS384" : "RS256",
              });
      }
    }
  }
});

afterAll(() => {
  Object.assign(Config, originalConfig);
  jest.restoreAllMocks();
  // Publish only after every cross-verification passed. Never record a key
  // capable of signing: the checked-in fixture contains the public key only.
  if (inputPath && verifiedCases === 54) {
    const { private_key: _privateKey, ...publicRecording } = recording;
    fs.writeFileSync(
      fixturePath,
      JSON.stringify(publicRecording, null, 2) + "\n"
    );
  }
});

it("records exactly three kinds and nine cases without a signing key", () => {
  expect(recording.now).toBe(1_800_000_000);
  expect(recording.cases).toHaveLength(27);
  expect(
    new Set(recording.cases.map((c) => `${c.kind}/${c.variant}`)).size
  ).toBe(27);
  if (!inputPath) expect(recording.private_key).toBeUndefined();
});

for (const signer of ["rust", "node"] as const) {
  describe(`${signer}-minted participant JWTs`, () => {
    it.each(recording.cases)("$kind / $variant", async (c) => {
      const token = c[`${signer}_token`];
      expect(jwt.decode(token, { complete: true })).toEqual({
        header: {
          alg:
            c.variant === "wrong_algorithm"
              ? "RS384"
              : c.variant === "unsigned_none"
              ? "none"
              : c.variant === "hs256_public_key"
              ? "HS256"
              : "RS256",
          typ: "JWT",
        },
        payload: c.claims,
        signature: token.split(".")[2],
      });
      const [header, payload, signature] = token.split(".");
      if (c.variant === "unsigned_none") expect(signature).toBe("");
      if (c.variant === "hs256_public_key") {
        // A correct HMAC keyed with the public PEM: only verification refuses it.
        expect(signature).toBe(
          createHmac("sha256", recording.public_key)
            .update(`${header}.${payload}`)
            .digest("base64url")
        );
      }
      const req: any = { headers: { authorization: `Bearer ${token}` } };
      // Exercise the actual express-jwt middleware and production options.
      const error: any = await new Promise((resolve) => {
        createJwtValidation("verified")(req, {} as any, (err) => resolve(err));
      });
      if (c.accepted) {
        expect(error).toBeUndefined();
        expect(req.verified).toEqual(c.claims);
      } else {
        expect(error?.code).toBe("invalid_token");
        expect(req.verified).toBeUndefined();
        if (c.variant === "expires_at_now") {
          expect(error.inner.name).toBe("TokenExpiredError");
        }
        if (c.variant === "unsigned_none") {
          expect(error.inner.message).toBe("jwt signature is required");
        }
        if (c.variant === "hs256_public_key") {
          expect(error.inner.message).toBe("invalid algorithm");
        }
      }
      verifiedCases++;
    });
  });
}

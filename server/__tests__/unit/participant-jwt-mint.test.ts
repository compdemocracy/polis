import fs from "node:fs";
import path from "node:path";
import { generateKeyPairSync } from "node:crypto";
import jwt from "jsonwebtoken";
import Config from "../../src/config";
import { createJwtValidation, issueParticipantJWT } from "../../src/auth/jwt-utils";

type Case = {
  kind: "anonymous" | "xid" | "standard_user";
  conversation: string;
  identifier: string;
  uid: number;
  pid: number;
  exp_now: number;
  iat_now: number;
  rust_token?: string;
  rust_refused?: boolean;
  node_token?: string;
};
type Recording = {
  public_key: string;
  private_key?: string;
  cases: Case[];
};
const fixturePath = path.join(__dirname, "../fixtures/participant-jwt/participant-mint.json");
const inputPath = process.env.POLIS_MINT_RECORD_INPUT;
const recording: Recording = JSON.parse(fs.readFileSync(inputPath || fixturePath, "utf8"));
const originalConfig = {
  jwtPrivateKey: Config.jwtPrivateKey,
  jwtPublicKey: Config.jwtPublicKey,
  polisJwtIssuer: Config.polisJwtIssuer,
  polisJwtAudience: Config.polisJwtAudience,
};
let freshPublicKey: string;
let passed = 0;
let complete = false;
const signingInput = (token: string) => token.split(".").slice(0, 2).join(".");

beforeAll(() => {
  const keys = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
  if (inputPath && !recording.private_key) throw new Error("Missing generated test key");
  Config.jwtPrivateKey = inputPath ? recording.private_key! : keys.privateKey;
  freshPublicKey = inputPath ? recording.public_key : keys.publicKey;
  Config.jwtPublicKey = recording.public_key;
  Config.polisJwtIssuer = "https://pol.is/";
  Config.polisJwtAudience = "participants";
});
afterEach(() => jest.restoreAllMocks());
afterAll(() => {
  Object.assign(Config, originalConfig);
  if (inputPath && complete && passed === recording.cases.length + 2) {
    const { private_key: _privateKey, ...publicRecording } = recording;
    fs.writeFileSync(fixturePath, JSON.stringify(publicRecording, null, 2) + "\n");
  }
});

it("contains all ten generated cases and no recorded signing key", () => {
  expect(recording.cases).toHaveLength(10);
  expect(new Set(recording.cases.map((c) => JSON.stringify([
    c.kind, c.conversation, c.identifier, c.uid, c.pid, c.exp_now, c.iat_now,
  ]))).size).toBe(10);
  expect(recording.cases.filter((c) => c.kind === "anonymous")).toHaveLength(2);
  expect(recording.cases.filter((c) => c.kind === "xid")).toHaveLength(4);
  expect(recording.cases.filter((c) => c.kind === "standard_user")).toHaveLength(4);
  if (!inputPath) expect(recording.private_key === undefined).toBe(true);
  complete = true;
});

recording.cases.forEach((c, index) => {
  it(`re-mints signing bytes and cross-verifies case ${index + 1}`, async () => {
    const clock = jest.spyOn(Date, "now").mockReturnValue(c.iat_now * 1000 + 999)
      .mockReturnValueOnce(c.exp_now * 1000 + 999)
      .mockReturnValueOnce(c.iat_now * 1000 + 999);
    // Use the real Node issuer on every run; decoding objects would miss a
    // header/claim-order change. Assertion failures never print token bytes.
    const token = c.kind === "anonymous"
      ? issueParticipantJWT("anonymous", c.conversation, c.uid, c.pid)
      : c.kind === "xid"
      ? issueParticipantJWT("xid", c.conversation, c.uid, c.pid, c.identifier)
      : issueParticipantJWT("standard_user", c.conversation, c.uid, c.pid, c.identifier);
    expect(clock).toHaveBeenCalledTimes(2);
    const blankXid = c.kind === "xid" && c.identifier.trim() === "";
    expect(c.rust_refused === true).toBe(blankXid);
    expect(typeof c.rust_token === "string").toBe(!blankXid);
    if (inputPath) {
      if (!blankXid) expect(token === c.rust_token).toBe(true);
    } else {
      expect(typeof c.node_token === "string").toBe(true);
      expect(signingInput(token) === signingInput(c.node_token!)).toBe(true);
    }
    const freshClaims = jwt.verify(token, freshPublicKey, {
      algorithms: ["RS256"], issuer: Config.polisJwtIssuer,
      audience: Config.polisJwtAudience, clockTimestamp: c.iat_now,
    });
    for (const recordedToken of [c.rust_token, inputPath ? token : c.node_token]) {
      if (recordedToken === undefined) continue;
      const req: any = { headers: { authorization: `Bearer ${recordedToken}` } };
      const error: any = await new Promise((resolve) => {
        createJwtValidation("verified")(req, {} as any, resolve);
      });
      expect(error === undefined).toBe(true);
      expect(JSON.stringify(req.verified) === JSON.stringify(freshClaims)).toBe(true);
    }
    if (inputPath) c.node_token = token;
    passed++;
  });
});

it.each(["xid", "standard_user"] as const)("empty identifier refused: %s", (kind) => {
  const issue = () => kind === "xid"
    ? issueParticipantJWT("xid", "2jwt-test", 3, 0, "")
    : issueParticipantJWT("standard_user", "2jwt-test", 3, 0, "");
  expect(issue).toThrow(/required/);
  passed++;
});

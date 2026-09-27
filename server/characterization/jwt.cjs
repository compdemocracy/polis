"use strict";
const crypto = require("node:crypto");
function verifyToken(token, binding) {
  if (!binding?.publicKey) throw Error("JWT verification key/binding required");
  const parts = token.split(".");
  if (parts.length !== 3) throw Error("invalid JWT encoding");
  const header = JSON.parse(Buffer.from(parts[0], "base64url")),
    claims = JSON.parse(Buffer.from(parts[1], "base64url"));
  if (
    header.alg !== "RS256" ||
    !crypto.verify(
      "RSA-SHA256",
      Buffer.from(parts.slice(0, 2).join(".")),
      binding.publicKey,
      Buffer.from(parts[2], "base64url")
    )
  )
    throw Error("invalid JWT signature/algorithm");
  const now = binding.now ?? Math.floor(Date.now() / 1000);
  if (
    claims.iss !== binding.issuer ||
    claims.aud !== binding.audience ||
    !Number.isInteger(claims.iat) ||
    !Number.isInteger(claims.exp) ||
    claims.iat > now + 5 ||
    claims.exp <= now ||
    claims.exp - claims.iat !== binding.ttl
  )
    throw Error("invalid JWT issuer/audience/expiry");
  if (binding.participants) {
    const row = binding.participants.find(
      (p) =>
        p.uid === claims.uid &&
        p.pid === claims.pid &&
        p.zid === (binding.zid ?? 1)
    );
    if (
      !row ||
      (binding.actorUid !== undefined && row.uid !== binding.actorUid)
    )
      throw Error("JWT actor has no matching participant row");
    binding = {
      ...binding,
      uid: row.uid,
      pid: row.pid,
      sub: claims.anonymous_participant
        ? "anon:" + row.uid
        : claims.standard_user_participant && binding.oidcSub
        ? "user:" + binding.oidcSub
        : claims.xid_participant && binding.xid
        ? "xid:" + binding.xid
        : undefined,
    };
  }
  for (const field of ["conversation_id", "uid", "pid", "sub"])
    if (binding[field] === undefined || claims[field] !== binding[field])
      throw Error("invalid JWT binding: " + field);
  const ttl = claims.exp - claims.iat;
  delete claims.exp;
  delete claims.iat;
  return { $jwt: claims, ttl, header };
}
module.exports = { verifyToken };

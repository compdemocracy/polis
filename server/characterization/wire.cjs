"use strict";
const { policy, Normalizer } = require("./normalize.cjs");
const bytes = (c) =>
  Buffer.concat(
    c.wire.response.body.map((x) => Buffer.from(x.bytes.base64, "base64"))
  );
// Visit JSON string VALUES by path without reserializing any other byte. This
// preserves whitespace, key order, escaping, number spelling and array order.
function strings(text, replace) {
  JSON.parse(text);
  const tokens =
    /\s+|"(?:[^"\\]|\\.)*"|[{}[\],:]|true|false|null|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/gy;
  const edits = [];
  let token;
  function next() {
    do {
      token = tokens.exec(text);
    } while (token && /^\s/.test(token[0]));
  }
  function value(path, key) {
    if (token[0] === "{") {
      next();
      while (token[0] !== "}") {
        const name = JSON.parse(token[0]);
        next();
        next();
        value([...path, name], name);
        if (token[0] !== ",") break;
        next();
      }
      next();
    } else if (token[0] === "[") {
      next();
      let i = 0;
      while (token[0] !== "]") {
        value([...path, i++], key);
        if (token[0] !== ",") break;
        next();
      }
      next();
    } else {
      if (token[0][0] === '"') {
        const original = JSON.parse(token[0]);
        const replacement = replace(original, path, key);
        if (replacement !== original)
          edits.push([
            token.index,
            token[0].length,
            JSON.stringify(replacement),
          ]);
      }
      next();
    }
  }
  next();
  value([], "");
  for (const [start, length, replacement] of edits.reverse())
    text = text.slice(0, start) + replacement + text.slice(start + length);
  return text;
}
function comparableBody(c) {
  const raw = bytes(c);
  if (
    !raw.length ||
    !c.wire.response.headers.some(
      (h) =>
        h.name.toLowerCase() === "content-type" &&
        h.value?.includes("application/json")
    ) ||
    raw[0] === 31
  )
    return raw.toString("base64");
  const normalizer = new Normalizer();
  // Bind only the contract's typed capabilities to their existing encounter-order
  // symbols. Never replace matching business text at unrelated paths.
  strings(raw.toString("utf8"), (v, path, key) => {
    const normalized = path.reduce((x, k) => x?.[k], c.response.body);
    if (
      policy.symbolFields.includes(key) &&
      typeof normalized === "string" &&
      normalized.startsWith("$")
    )
      normalizer.symbols.set(
        `${key === "zinvite" ? "conversation_id" : key}:${v}`,
        normalized
      );
    return v;
  });
  return Buffer.from(
    strings(raw.toString("utf8"), (v, path, key) => {
      if (policy.symbolFields.includes(key))
        return (
          normalizer.symbols.get(
            `${key === "zinvite" ? "conversation_id" : key}:${v}`
          ) || v
        );
      if (policy.urlFields.includes(key))
        return normalizer.normalize(
          v,
          "$.response.body." + path.join("."),
          key
        );
      return v;
    })
  ).toString("base64");
}
function comparableHeaders(c) {
  const raw = bytes(c),
    normalized = Buffer.from(comparableBody(c), "base64");
  const changed = !raw.equals(normalized);
  return c.wire.response.headers
    .filter(
      (h) =>
        !["date", "connection", "keep-alive"].includes(h.name.toLowerCase())
    )
    .map((h) => {
      if (
        c.credentialWireValidation &&
        ["content-length", "etag"].includes(h.name.toLowerCase())
      ) {
        const proof = c.credentialWireValidation;
        if (
          proof.kind !== "verified-jwt-values/1" ||
          proof.count !== c.effects.jwtIssued
        )
          throw Error("credential wire proof mismatch");
        const field =
          h.name.toLowerCase() === "etag" ? "etag" : "contentLength";
        if (h.value !== proof[field])
          throw Error("credential wire header changed after verification");
        return {
          ...h,
          value:
            field === "etag"
              ? require("express/lib/utils").wetag(normalized)
              : String(normalized.length),
        };
      }
      // Derived fields are exact for ordinary bodies. A capability substitution
      // changes bytes: prove the original derivation, then compare its normalized
      // derivation. Never simply drop Content-Length or ETag.
      if (changed && h.name.toLowerCase() === "content-length") {
        if (h.value !== String(raw.length))
          throw Error("wire Content-Length mismatch");
        return { ...h, value: String(normalized.length) };
      }
      if (changed && h.name.toLowerCase() === "etag") {
        const etag = require("express/lib/utils").wetag;
        if (h.value !== etag(raw)) throw Error("wire ETag mismatch");
        return { ...h, value: etag(normalized) };
      }
      return h;
    });
}
module.exports = { bytes, strings, comparableBody, comparableHeaders };

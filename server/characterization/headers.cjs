"use strict";
// Cookies need an explicit local fixture and exact attributes before credential
// substitution. An unclassified newly emitted cookie is an admission error.
function cookie(value, fixtures = {}) {
  const [pair, ...attributes] = value.split(";").map((x) => x.trim()),
    at = pair.indexOf("="),
    name = pair.slice(0, at),
    secret = pair.slice(at + 1),
    fixture = fixtures[name];
  if (
    at < 1 ||
    !fixture ||
    fixture.value !== secret ||
    JSON.stringify(attributes) !== JSON.stringify(fixture.attributes)
  )
    throw Error("unclassified cookie or changed cookie attributes: " + name);
  return { name, symbol: "$cookie:" + name, attributes };
}
function headers(ordered, fixtures = {}) {
  return ordered.map((h) => {
    if (h.name.toLowerCase() !== "set-cookie") return h;
    const c = cookie(h.value, fixtures);
    return { ...h, value: c.attributes.join("; "), credential_ref: c.symbol };
  });
}
module.exports = { cookie, headers };

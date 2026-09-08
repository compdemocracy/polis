"use strict";
const assert = require("node:assert/strict");
const expected = {
  version: "p027-serialization/1",
  name: "production-compact",
  nodeEnv: "production",
  expressEnv: "production",
  jsonSpaces: null,
  jsonReplacer: null,
  jsonpCallbackName: "callback",
  etag: "weak",
  developmentErrorDetails: false,
  devModeFixtures: true,
  sqsEndpoint: "http://server:4566",
};
function profile(app) {
  return {
    version: "p027-serialization/1",
    name: "production-compact",
    nodeEnv: process.env.NODE_ENV,
    expressEnv: app.get("env"),
    jsonSpaces: app.get("json spaces") ?? null,
    jsonReplacer: app.get("json replacer") ?? null,
    jsonpCallbackName: app.get("jsonp callback name"),
    etag: app.get("etag"),
    developmentErrorDetails: process.env.NODE_ENV === "development",
    devModeFixtures: process.env.DEV_MODE === "true",
    sqsEndpoint: process.env.AWS_ENDPOINT_URL_SQS,
  };
}
function assertProfile(value) {
  assert.deepEqual(
    value,
    expected,
    "recording requires production-compact serialization"
  );
}
module.exports = { profile, assertProfile, expected };

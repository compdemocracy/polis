import { afterEach, describe, expect, test } from "@jest/globals";
import Config from "../../src/config";

// ROUTING_EPSILON and ROUTING_SERVE_LOG are read when asked, like
// TOPICAL_COMMENT_RATIO, so a test can set them without reloading the module.
const saved = {
  epsilon: process.env.ROUTING_EPSILON,
  serveLog: process.env.ROUTING_SERVE_LOG,
};

function setEnv(name: string, value: string | undefined) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

afterEach(() => {
  setEnv("ROUTING_EPSILON", saved.epsilon);
  setEnv("ROUTING_SERVE_LOG", saved.serveLog);
});

describe("Config.getValidRoutingEpsilon", () => {
  test.each([
    [undefined, null],
    ["", null],
    ["abc", null],
    ["NaN", null],
    ["Infinity", null],
    ["-0.1", null],
    ["1.5", null],
    ["0", 0],
    ["0.5", 0.5],
    ["1", 1],
  ])("ROUTING_EPSILON=%p gives %p", (raw, expected) => {
    setEnv("ROUTING_EPSILON", raw);
    expect(Config.getValidRoutingEpsilon()).toBe(expected);
  });
});

describe("Config.routingServeLog", () => {
  test.each([
    [undefined, true],
    ["", true],
    ["1", true],
    ["true", true],
    ["0", false],
    ["false", false],
  ])("ROUTING_SERVE_LOG=%p gives %p", (raw, expected) => {
    setEnv("ROUTING_SERVE_LOG", raw);
    expect(Config.routingServeLog).toBe(expected);
  });
});

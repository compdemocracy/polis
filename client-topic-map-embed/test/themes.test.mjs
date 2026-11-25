import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { chromeProperties, DEFAULT_THEME, themeFor, themeName } from "../src/themes.js";
import { DARK_GROUND, darkTheme, lift } from "../src/theme-dark.js";

const require = createRequire(import.meta.url);
const neutral = require("../../client-topic-map/theme-neutral.js");

test("light is the package's neutral theme, as it is", () => {
  assert.equal(themeFor("light"), neutral);
  assert.equal(neutral.ground, "#ffffff");
});

test("dark is the default, and an unknown name falls back to it", () => {
  assert.equal(DEFAULT_THEME, "dark");
  assert.equal(themeName(null), "dark");
  assert.equal(themeName("sepia"), "dark");
  assert.equal(themeFor(undefined).ground, DARK_GROUND);
});

test("the dark theme is a copy: the neutral theme is not changed", () => {
  const before = JSON.stringify(neutral);
  const dark = darkTheme(neutral);
  assert.equal(JSON.stringify(neutral), before);
  assert.equal(dark.ground, "#121212");
  assert.equal(dark.label.halo, "rgba(18,18,18,0.867)");
  assert.equal(dark.font.family, neutral.font.family);
  assert.equal(neutral.point.fill, "topic");
});

test("the dark theme lifts a topic's colour only below its floor", () => {
  const dark = darkTheme(neutral);
  const topic = { color: "#734252", colorAll: "#dd6a94" };
  assert.notEqual(dark.point.fill(topic, 0), "#734252");
  assert.equal(dark.point.fill(topic, "all"), lift("#dd6a94", 0.64));
  assert.equal(lift("#ffffff", 0.64), "#ffffff");
});

test("the page chrome takes its colours and type from the theme", () => {
  const p = chromeProperties(themeFor("dark"));
  assert.equal(p["--ground"], "#121212");
  assert.equal(p["--ui-size"], "14px");
  assert.equal(chromeProperties(neutral)["--ground"], "#ffffff");
});

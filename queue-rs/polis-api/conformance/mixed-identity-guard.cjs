"use strict";
// Synchronize the unchanged guard with offered admission work, outside its
// measured interval. Neither its assertions nor its deadlines are modified.
const fs = require("node:fs");
const dir = process.env.MIXED_ARTIFACTS;
beforeEach(async () => {
  fs.writeFileSync(dir + "/guard-ready", String(Date.now()));
  const deadline = Date.now() + 10000;
  while (!fs.existsSync(dir + "/load-active")) {
    if (Date.now() > deadline) throw Error("load did not start");
    await new Promise((r) => setTimeout(r, 5));
  }
  fs.writeFileSync(dir + "/guard-start", String(Date.now()));
});
afterEach(() => fs.writeFileSync(dir + "/guard-end", String(Date.now())));

const write = process.stdout.write;
process.stdout.write = function (chunk, ...args) {
  try {
    const value = JSON.parse(String(chunk));
    if (Object.hasOwn(value, "long_requests"))
      fs.writeFileSync(
        dir + "/guard-measurement",
        JSON.stringify({ end: Date.now(), ...value })
      );
  } catch {}
  return write.call(this, chunk, ...args);
};

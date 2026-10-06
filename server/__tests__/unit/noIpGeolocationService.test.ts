// Ruling 2026-10-05: the server stopped sending commenters' IP addresses to
// the third-party geolocation service ip-api.com "until better option or we
// do our own internal service". This scan fails if any server source file
// names that service again. If location is wanted again, use a geolocation
// database held on the server, behind an explicit setting that is off by
// default — not a request to a third party.
import fs from "fs";
import path from "path";

const SRC = path.resolve(__dirname, "../../src");
const FORBIDDEN = /ip-api\.com/i;

function sourceFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    return entry.isDirectory() ? sourceFiles(full) : [full];
  });
}

test("no server source file references the ip-api.com geolocation service", () => {
  const files = sourceFiles(SRC);
  expect(files.length).toBeGreaterThan(100);
  const offenders = files
    .filter((file) => FORBIDDEN.test(fs.readFileSync(file, "utf8")))
    .map((file) => path.relative(SRC, file));
  expect(offenders).toEqual([]);
});

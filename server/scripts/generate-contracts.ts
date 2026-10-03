// npm run contract:generate  -> write every generated contract file
// npm run contract:check     -> exit 1 if any committed file differs
//
// Outputs for a client directory that is absent (a server-only checkout, such
// as the server image build) are skipped.

import fs from "fs";
import path from "path";
import { presentOutputs, REPO_ROOT } from "../src/contracts/generate";

const check = process.argv.includes("--check");
const stale: string[] = [];

for (const output of presentOutputs()) {
  const target = path.join(REPO_ROOT, output.path);
  const current = fs.existsSync(target)
    ? fs.readFileSync(target, "utf8")
    : null;
  if (current === output.content) continue;
  if (check) {
    stale.push(output.path);
  } else {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, output.content);
    process.stdout.write(`contract: wrote ${output.path}\n`);
  }
}

if (stale.length > 0) {
  const list = stale.map((file) => `  ${file}\n`).join("");
  process.stderr.write(
    `contract: generated files differ from the TypeBox source; run npm run contract:generate in server/:\n${list}`
  );
  process.exit(1);
}

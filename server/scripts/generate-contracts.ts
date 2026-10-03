// npm run contract:generate  -> write every generated contract file
// npm run contract:check     -> exit 1 if any committed file differs
//
// Outputs whose directory has no package.json at the resolved repository root
// are skipped: in the server image build (WORKDIR /app, no checkout above it)
// nothing is written. Nothing is ever written outside the repository root.

import fs from "fs";
import path from "path";
import { presentOutputs, REPO_ROOT } from "../src/contracts/generate";

const check = process.argv.includes("--check");
const stale: string[] = [];

for (const output of presentOutputs()) {
  const target = path.resolve(REPO_ROOT, output.path);
  if (!target.startsWith(REPO_ROOT + path.sep)) {
    throw new Error(
      `contract: refusing to write outside the repository: ${target}`
    );
  }
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

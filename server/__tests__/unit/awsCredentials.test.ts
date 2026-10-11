import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);

describe.each(["static", "role"])("AWS credentials: %s", (mode) => {
  it.each(["SES", "S3", "DynamoDB", "SQS"])(
    "signs %s using the selected identity",
    async (service) => {
      const { stdout } = await exec(
        process.execPath,
        [path.join(__dirname, "aws-credentials-child.cjs"), mode, service],
        { cwd: path.join(__dirname, "../.."), timeout: 20000 },
      );
      const proof = JSON.parse(stdout);
      expect(proof.requests).toHaveLength(1);
      expect(proof.requests[0].auth).toContain(
        `Credential=generated-${mode}-id/`,
      );
      expect(proof.requests[0].token).toBe(
        mode === "role" ? "generated-role-token" : undefined,
      );
      expect(proof.roleReads).toBe(mode === "role" ? 1 : 0);
    },
  );
});

// Drift test: the committed generated files must equal what the TypeBox
// source renders now. Fix a failure with `npm run contract:generate` in
// server/ and commit the result (`npm run contract:check` is the same check).

import { describe, expect, test } from "@jest/globals";
import fs from "fs";
import path from "path";
import { Type } from "@sinclair/typebox";
import {
  REPO_ROOT,
  renderContracts,
  schemaDocument,
} from "../../../src/contracts/generate";

describe("generated contract files", () => {
  const outputs = renderContracts();

  test("cover the server, alpha and client-report outputs", () => {
    expect(outputs.map((o) => o.path).sort()).toEqual([
      "client-participation-alpha/src/api/contract/delphiJobResult.schema.json",
      "client-participation-alpha/src/api/contract/pca2.schema.json",
      "client-participation-alpha/src/api/delphi.types.ts",
      "client-report/src/contract/delphiJobResult.schema.json",
      "client-report/src/contract/pca2.schema.json",
      "client-report/src/contract/validate.js",
      "server/src/contracts/delphiJobResult.schema.json",
      "server/src/contracts/pca2.schema.json",
    ]);
  });

  test.each(outputs.map((o) => [o.path, o]))(
    "%s matches the TypeBox source",
    (file, output) => {
      const committed = fs.readFileSync(
        path.join(REPO_ROOT, file as string),
        "utf8"
      );
      expect(committed).toBe((output as { content: string }).content);
    }
  );

  test("every client copy of a schema is the server schema", () => {
    for (const name of ["delphiJobResult", "pca2"]) {
      const server = JSON.parse(
        fs.readFileSync(
          path.join(REPO_ROOT, `server/src/contracts/${name}.schema.json`),
          "utf8"
        )
      );
      for (const client of [
        `client-participation-alpha/src/api/contract/${name}.schema.json`,
        `client-report/src/contract/${name}.schema.json`,
      ]) {
        expect(
          JSON.parse(fs.readFileSync(path.join(REPO_ROOT, client), "utf8"))
        ).toEqual(server);
      }
    }
  });

  test("generation refuses a keyword the client-report validator does not implement", () => {
    expect(() => schemaDocument(Type.String({ format: "date-time" }))).toThrow(
      /unsupported keyword "format"/
    );
  });
});

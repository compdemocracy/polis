// Copyright (C) 2012-present, The Authors. This program is free software: you can redistribute it and/or  modify it under the terms of the GNU Affero General Public License, version 3, as published by the Free Software Foundation. This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU Affero General Public License for more details. You should have received a copy of the GNU Affero General Public License along with this program.  If not, see <http://www.gnu.org/licenses/>.

// P-070 review [1447] B: `processMathObject` dereferenced every
// group-clusters entry, so a published `[null]` threw a TypeError in the
// presentation path. It now refuses the malformed field (presented as no
// groups, logged) and still normalizes a valid payload exactly as before.

import { describe, expect, jest, test } from "@jest/globals";

jest.mock("../../src/db/pg-query", () => ({
  __esModule: true,
  default: { queryP_readOnly: jest.fn() },
}));

jest.mock("../../src/config", () => ({
  __esModule: true,
  default: { mathEnv: "test-math-env", cacheMathResults: true },
}));

const loggerError = jest.fn();
jest.mock("../../src/utils/logger", () => ({
  __esModule: true,
  default: {
    info: () => undefined,
    silly: () => undefined,
    debug: () => undefined,
    warn: () => undefined,
    error: (...args: unknown[]) => loggerError(...args),
  },
}));

jest.mock("../../src/utils/metered", () => ({
  __esModule: true,
  addInRamMetric: () => undefined,
  MPromise: Promise,
}));

import { processMathObject } from "../../src/utils/pca";

describe("processMathObject refuses malformed group entries", () => {
  test("valid control: groups are normalized with their ids", () => {
    const out = processMathObject({
      "group-clusters": [{ id: 0, members: [0] }],
      repness: { 0: [] },
    });
    expect(out["group-clusters"]).toEqual([{ id: 0, members: [0] }]);
    expect(out.repness[0]).toEqual(Object.assign([], { id: 0 }));
  });

  test.each([[[null]], [["broken"]], [[{ id: 0, members: [0] }, null]]])(
    "group-clusters %j is refused, not dereferenced",
    (groups) => {
      loggerError.mockClear();
      let out: any;
      expect(() => {
        out = processMathObject({ "group-clusters": groups as any });
      }).not.toThrow();
      expect(out["group-clusters"]).toEqual([]);
      expect(loggerError).toHaveBeenCalledWith(
        "polis_err_math_malformed_group_clusters",
        expect.anything()
      );
    }
  );

  test("a malformed repness entry is skipped instead of throwing", () => {
    const out = processMathObject({
      "group-clusters": [],
      repness: { 0: null, 1: [] },
    });
    expect(Object.keys(out.repness)).toEqual(["1"]);
  });
});

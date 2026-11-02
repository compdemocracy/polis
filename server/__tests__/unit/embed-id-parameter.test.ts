import { getEmbedId } from "../../src/utils/parameter";

jest.mock("../../src/db/pg-query", () => ({ __esModule: true, default: {} }));
jest.mock("../../src/user", () => ({}));
jest.mock("../../src/conversation", () => ({}));

describe.each(["site_id", "page_id"] as const)("%s length", (name) => {
  test.each([1, 100, 150, 2000])(
    "accepts %i characters unchanged",
    async (length) => {
      const id = "x".repeat(length);
      await expect(getEmbedId(id, name)).resolves.toBe(id);
    }
  );

  test.each([undefined, null, 1, [], "", "x".repeat(2001)])(
    "rejects invalid input %#",
    async (id) => {
      await expect(getEmbedId(id, name)).rejects.toThrow(
        `polis_err_${name}_length_1_to_2000`
      );
    }
  );

  test("preserves spaces and encoding and counts Unicode characters", async () => {
    for (const id of [" a%2Fb ", "😀".repeat(2000)]) {
      await expect(getEmbedId(id, name)).resolves.toBe(id);
    }
  });
});

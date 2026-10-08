import { getApp } from "../app-loader";

async function getPaths(): Promise<(string | RegExp)[]> {
  const app = await getApp();
  // Express 3's runtime registry is not present in the Express 4 typings.
  const registry = app as unknown as {
    routes: { get: { path: string | RegExp }[] };
  };
  return registry.routes.get.map((route) => route.path);
}

describe("retired legacy narrative routes", () => {
  test.each([
    "reportNarrative",
    "narrativeReport",
    "topicMapNarrativeReport",
  ])("%s has no route registration", async (name) => {
    // Unknown URLs retain the existing generic static proxy behavior. This
    // assertion distinguishes removed handlers from a storage/auth failure in
    // a still-registered handler, without depending on a static file server.
    const paths = await getPaths();
    expect(paths.some((path) => String(path).includes(name))).toBe(false);
  });
  test.each([
    "/api/v3/delphi/reports",
    "/api/v3/delphi",
    "/api/v3/collectiveStatement",
  ])("%s retains its reader registration", async (path) => {
    expect(await getPaths()).toContain(path);
  });
});

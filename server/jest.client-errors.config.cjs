module.exports = {
  testEnvironment: "node",
  testMatch: [
    "**/__tests__/unit/client-errors.test.ts",
    "**/__tests__/unit/contracts/contractDrift.test.ts",
  ],
  transform: { "^.+\\.tsx?$": ["ts-jest", { tsconfig: "tsconfig.json" }] },
};

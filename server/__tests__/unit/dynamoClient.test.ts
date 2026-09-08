/**
 * Credential-precedence tests for the shared DynamoDB client builder.
 *
 * Regression cover for the defect where `utils/storage.ts` and
 * `routes/delphi/batchReports.ts` had no default-credential-chain fallback and
 * therefore sent the literal "local" placeholder that `config.ts` substitutes
 * for unset AWS environment variables.
 */
import {
  buildDynamoClientConfig,
  CONFIG_PLACEHOLDER,
  DEFAULT_REGION,
  LOCAL_ENDPOINT_ACCESS_KEY_ID,
  LOCAL_ENDPOINT_SECRET_ACCESS_KEY,
} from "../../src/utils/dynamoClient";

jest.mock("../../src/utils/logger", () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

describe("buildDynamoClientConfig credential precedence", () => {
  describe("branch 1: explicit endpoint (DynamoDB Local)", () => {
    it("uses the endpoint with synthetic credentials", () => {
      const config = buildDynamoClientConfig({
        endpoint: "http://host.docker.internal:8000",
        region: "us-east-1",
        accessKeyId: "REAL_LOOKING_ID",
        secretAccessKey: "REAL_LOOKING_SECRET",
      });

      expect(config.endpoint).toBe("http://host.docker.internal:8000");
      expect(config.credentials).toEqual({
        accessKeyId: LOCAL_ENDPOINT_ACCESS_KEY_ID,
        secretAccessKey: LOCAL_ENDPOINT_SECRET_ACCESS_KEY,
      });
      // Configured credentials must not be forwarded to the local endpoint.
      expect(JSON.stringify(config)).not.toContain("REAL_LOOKING_SECRET");
    });

    it("takes precedence over configured credentials and placeholders alike", () => {
      const config = buildDynamoClientConfig({
        endpoint: "http://dynamodb:8000",
        region: CONFIG_PLACEHOLDER,
        accessKeyId: CONFIG_PLACEHOLDER,
        secretAccessKey: CONFIG_PLACEHOLDER,
      });

      expect(config.endpoint).toBe("http://dynamodb:8000");
      expect(config.region).toBe(DEFAULT_REGION);
      expect(config.credentials).toEqual({
        accessKeyId: LOCAL_ENDPOINT_ACCESS_KEY_ID,
        secretAccessKey: LOCAL_ENDPOINT_SECRET_ACCESS_KEY,
      });
    });
  });

  describe("branch 2: real configured credentials", () => {
    it("passes both keys through when no endpoint is set", () => {
      const config = buildDynamoClientConfig({
        endpoint: null,
        region: "us-west-2",
        accessKeyId: "CONFIGURED_ID",
        secretAccessKey: "CONFIGURED_SECRET",
      });

      expect(config.endpoint).toBeUndefined();
      expect(config.region).toBe("us-west-2");
      expect(config.credentials).toEqual({
        accessKeyId: "CONFIGURED_ID",
        secretAccessKey: "CONFIGURED_SECRET",
      });
    });

    it("falls through to the default chain when only one key is set", () => {
      const config = buildDynamoClientConfig({
        endpoint: null,
        region: "us-east-1",
        accessKeyId: "CONFIGURED_ID",
        secretAccessKey: null,
      });

      expect(config.credentials).toBeUndefined();
    });
  });

  describe("branch 3: default AWS credential provider chain", () => {
    it("omits credentials when nothing is configured", () => {
      const config = buildDynamoClientConfig({
        endpoint: null,
        region: null,
        accessKeyId: null,
        secretAccessKey: null,
      });

      expect(config.credentials).toBeUndefined();
      expect(config.endpoint).toBeUndefined();
      expect(config.region).toBe(DEFAULT_REGION);
    });

    it('treats the "local" placeholder as unset and never sends it to AWS', () => {
      // This is the exact shape config.ts produces when AWS_ACCESS_KEY_ID,
      // AWS_SECRET_ACCESS_KEY and AWS_REGION are all unset in prod.
      const config = buildDynamoClientConfig({
        endpoint: null,
        region: CONFIG_PLACEHOLDER,
        accessKeyId: CONFIG_PLACEHOLDER,
        secretAccessKey: CONFIG_PLACEHOLDER,
      });

      expect(config.credentials).toBeUndefined();
      expect(config.region).toBe(DEFAULT_REGION);
      expect(config.region).not.toBe(CONFIG_PLACEHOLDER);
      expect(JSON.stringify(config)).not.toContain(CONFIG_PLACEHOLDER);
    });

    it("keeps a real region while still using the default chain", () => {
      const config = buildDynamoClientConfig({
        endpoint: null,
        region: "us-east-1",
        accessKeyId: CONFIG_PLACEHOLDER,
        secretAccessKey: CONFIG_PLACEHOLDER,
      });

      expect(config.region).toBe("us-east-1");
      expect(config.credentials).toBeUndefined();
    });

    it("treats empty strings as unset", () => {
      const config = buildDynamoClientConfig({
        endpoint: "",
        region: "",
        accessKeyId: "",
        secretAccessKey: "",
      });

      expect(config.endpoint).toBeUndefined();
      expect(config.credentials).toBeUndefined();
      expect(config.region).toBe(DEFAULT_REGION);
    });
  });
});

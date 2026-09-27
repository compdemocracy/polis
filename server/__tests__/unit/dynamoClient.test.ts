/**
 * Credential-precedence tests for the shared DynamoDB client builder.
 *
 * Regression cover for the defect where `utils/storage.ts` and
 * `routes/delphi/batchReports.ts` had no default-credential-chain fallback and
 * therefore sent the literal "local" placeholder that `config.ts` substitutes
 * for unset AWS environment variables.
 */
import {
  AwsCredentialsConfigurationError,
  buildDynamoClientConfig,
  CONFIG_PLACEHOLDER,
  DEFAULT_REGION,
  LOCAL_ENDPOINT_ACCESS_KEY_ID,
  LOCAL_ENDPOINT_SECRET_ACCESS_KEY,
  makeDynamoClient,
  PLACEHOLDER_CREDENTIALS_ERROR_CODE,
} from "../../src/utils/dynamoClient";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";

jest.mock("../../src/utils/logger", () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

jest.mock("@aws-sdk/client-dynamodb", () => ({
  __esModule: true,
  DynamoDBClient: jest.fn(),
}));

const DynamoDBClientMock = DynamoDBClient as unknown as jest.Mock;

/** An environment with neither AWS credential variable set. */
const EMPTY_ENV = {};

/** The environment as it looks when the placeholder is set explicitly. */
const PLACEHOLDER_ENV = {
  AWS_ACCESS_KEY_ID: CONFIG_PLACEHOLDER,
  AWS_SECRET_ACCESS_KEY: CONFIG_PLACEHOLDER,
};

describe("buildDynamoClientConfig credential precedence", () => {
  describe("branch 1: explicit endpoint (DynamoDB Local)", () => {
    it("uses the endpoint with public-fixture credentials", () => {
      const config = buildDynamoClientConfig(
        {
          endpoint: "http://host.docker.internal:8000",
          region: "us-east-1",
          accessKeyId: "REAL_LOOKING_ID",
          secretAccessKey: "REAL_LOOKING_SECRET",
        },
        EMPTY_ENV
      );

      expect(config.endpoint).toBe("http://host.docker.internal:8000");
      expect(config.credentials).toEqual({
        accessKeyId: LOCAL_ENDPOINT_ACCESS_KEY_ID,
        secretAccessKey: LOCAL_ENDPOINT_SECRET_ACCESS_KEY,
      });
      // Configured credentials must not be forwarded to the local endpoint.
      expect(JSON.stringify(config)).not.toContain("REAL_LOOKING_SECRET");
    });

    it("takes precedence over configured credentials and placeholders alike", () => {
      const config = buildDynamoClientConfig(
        {
          endpoint: "http://dynamodb:8000",
          region: CONFIG_PLACEHOLDER,
          accessKeyId: CONFIG_PLACEHOLDER,
          secretAccessKey: CONFIG_PLACEHOLDER,
        },
        PLACEHOLDER_ENV
      );

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
      const config = buildDynamoClientConfig(
        {
          endpoint: null,
          region: "us-west-2",
          accessKeyId: "CONFIGURED_ID",
          secretAccessKey: "CONFIGURED_SECRET",
        },
        EMPTY_ENV
      );

      expect(config.endpoint).toBeUndefined();
      expect(config.region).toBe("us-west-2");
      expect(config.credentials).toEqual({
        accessKeyId: "CONFIGURED_ID",
        secretAccessKey: "CONFIGURED_SECRET",
      });
    });

    it("falls through to the default chain when only one key is set", () => {
      const config = buildDynamoClientConfig(
        {
          endpoint: null,
          region: "us-east-1",
          accessKeyId: "CONFIGURED_ID",
          secretAccessKey: null,
        },
        EMPTY_ENV
      );

      expect(config.credentials).toBeUndefined();
    });
  });

  describe("branch 3: default AWS credential provider chain", () => {
    it("omits credentials when nothing is configured", () => {
      const config = buildDynamoClientConfig(
        {
          endpoint: null,
          region: null,
          accessKeyId: null,
          secretAccessKey: null,
        },
        EMPTY_ENV
      );

      expect(config.credentials).toBeUndefined();
      expect(config.endpoint).toBeUndefined();
      expect(config.region).toBe(DEFAULT_REGION);
    });

    it('treats a config-generated "local" placeholder as unset', () => {
      // The exact shape config.ts produces when AWS_ACCESS_KEY_ID,
      // AWS_SECRET_ACCESS_KEY and AWS_REGION are all *absent* from the
      // environment: config.ts invents the placeholders, the environment holds
      // nothing, and the default chain is safe to use.
      const config = buildDynamoClientConfig(
        {
          endpoint: null,
          region: CONFIG_PLACEHOLDER,
          accessKeyId: CONFIG_PLACEHOLDER,
          secretAccessKey: CONFIG_PLACEHOLDER,
        },
        EMPTY_ENV
      );

      expect(config.credentials).toBeUndefined();
      expect(config.region).toBe(DEFAULT_REGION);
      expect(config.region).not.toBe(CONFIG_PLACEHOLDER);
      expect(JSON.stringify(config)).not.toContain(CONFIG_PLACEHOLDER);
    });

    it("keeps a real region while still using the default chain", () => {
      const config = buildDynamoClientConfig(
        {
          endpoint: null,
          region: "us-east-1",
          accessKeyId: CONFIG_PLACEHOLDER,
          secretAccessKey: CONFIG_PLACEHOLDER,
        },
        EMPTY_ENV
      );

      expect(config.region).toBe("us-east-1");
      expect(config.credentials).toBeUndefined();
    });

    it("treats empty strings as unset", () => {
      const config = buildDynamoClientConfig(
        {
          endpoint: "",
          region: "",
          accessKeyId: "",
          secretAccessKey: "",
        },
        EMPTY_ENV
      );

      expect(config.endpoint).toBeUndefined();
      expect(config.credentials).toBeUndefined();
      expect(config.region).toBe(DEFAULT_REGION);
    });
  });

  /**
   * Review finding F1. Omitting `credentials` does not stop the SDK's own
   * environment provider from re-reading `process.env` afterwards, so an
   * explicitly-set placeholder would still reach AWS. When that would happen,
   * the builder refuses rather than pretending to have filtered it.
   */
  describe("placeholder present in the environment (not merely unset)", () => {
    beforeEach(() => {
      DynamoDBClientMock.mockClear();
    });

    it("throws a named configuration error instead of using the default chain", () => {
      expect(() =>
        buildDynamoClientConfig(
          {
            endpoint: null,
            region: CONFIG_PLACEHOLDER,
            accessKeyId: CONFIG_PLACEHOLDER,
            secretAccessKey: CONFIG_PLACEHOLDER,
          },
          PLACEHOLDER_ENV
        )
      ).toThrow(AwsCredentialsConfigurationError);
    });

    it("reports polis_err_aws_credentials_placeholder", () => {
      expect.assertions(3);
      try {
        buildDynamoClientConfig({}, PLACEHOLDER_ENV);
      } catch (error) {
        const configError = error as AwsCredentialsConfigurationError;
        expect(configError.code).toBe(PLACEHOLDER_CREDENTIALS_ERROR_CODE);
        expect(configError.name).toBe("AwsCredentialsConfigurationError");
        // The message names the variables, never a credential value.
        expect(configError.message).toContain("AWS_ACCESS_KEY_ID");
      }
    });

    it("throws when only the access key id is the placeholder", () => {
      expect(() =>
        buildDynamoClientConfig(
          {
            accessKeyId: CONFIG_PLACEHOLDER,
            secretAccessKey: "REAL_LOOKING_SECRET",
          },
          { AWS_ACCESS_KEY_ID: CONFIG_PLACEHOLDER }
        )
      ).toThrow(AwsCredentialsConfigurationError);
    });

    it("does not construct a client when it throws", () => {
      expect(() => makeDynamoClient({}, PLACEHOLDER_ENV)).toThrow(
        AwsCredentialsConfigurationError
      );
      expect(DynamoDBClientMock).not.toHaveBeenCalled();
    });

    it("still constructs a client when the environment is clean", () => {
      const client = makeDynamoClient({}, EMPTY_ENV);

      expect(client).toBeDefined();
      expect(DynamoDBClientMock).toHaveBeenCalledTimes(1);
      expect(DynamoDBClientMock.mock.calls[0][0].credentials).toBeUndefined();
    });

    it("does not throw in local-endpoint mode, which never reads the environment provider", () => {
      const config = buildDynamoClientConfig(
        { endpoint: "http://dynamodb:8000" },
        PLACEHOLDER_ENV
      );

      expect(config.credentials).toEqual({
        accessKeyId: LOCAL_ENDPOINT_ACCESS_KEY_ID,
        secretAccessKey: LOCAL_ENDPOINT_SECRET_ACCESS_KEY,
      });
    });

    it("does not throw when a real pair is configured explicitly", () => {
      // Explicit credentials short-circuit the chain, so a stale placeholder
      // elsewhere in the environment is never consulted.
      const config = buildDynamoClientConfig(
        { accessKeyId: "CONFIGURED_ID", secretAccessKey: "CONFIGURED_SECRET" },
        PLACEHOLDER_ENV
      );

      expect(config.credentials).toEqual({
        accessKeyId: "CONFIGURED_ID",
        secretAccessKey: "CONFIGURED_SECRET",
      });
    });

    it("reads the live process.env by default", () => {
      // eslint-disable-next-line no-restricted-properties
      const realEnv = process.env;
      // eslint-disable-next-line no-restricted-properties
      process.env = {
        ...realEnv,
        AWS_ACCESS_KEY_ID: CONFIG_PLACEHOLDER,
        AWS_SECRET_ACCESS_KEY: CONFIG_PLACEHOLDER,
      };
      try {
        expect(() => buildDynamoClientConfig({})).toThrow(
          AwsCredentialsConfigurationError
        );
      } finally {
        // eslint-disable-next-line no-restricted-properties
        process.env = realEnv;
      }
    });
  });
});

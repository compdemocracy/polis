import { DynamoDBClient, DynamoDBClientConfig } from "@aws-sdk/client-dynamodb";
import config from "../config";
import logger from "./logger";

/**
 * Shared DynamoDB client construction.
 *
 * Every DynamoDB client in the server must resolve credentials the same way:
 *
 *   1. `DYNAMODB_ENDPOINT` set  -> DynamoDB Local. Send synthetic credentials;
 *      DynamoDB Local accepts any syntactically valid pair and never validates
 *      them, so no real credential is ever needed (or leaked) locally.
 *   2. Real `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` -> use them explicitly.
 *   3. Otherwise -> pass no `credentials`, so the AWS SDK uses its default
 *      credential provider chain (on EC2 that is the instance role).
 *
 * The placeholder guard in step 2 is load-bearing. `config.ts` substitutes the
 * literal string "local" for `awsAccessKeyId`, `awsSecretAccessKey` and
 * `awsRegion` when the corresponding environment variables are unset, so a
 * plain truthiness check would send `accessKeyId="local"` to region "local" and
 * fail at the first call rather than falling through to the instance role.
 * A placeholder must never reach AWS: it is treated exactly like "unset".
 */

/** Literal that `config.ts` substitutes for unset AWS environment variables. */
export const CONFIG_PLACEHOLDER = "local";

/** Credentials used against DynamoDB Local; not valid anywhere else. */
export const LOCAL_ENDPOINT_ACCESS_KEY_ID = "DUMMYIDEXAMPLE";
export const LOCAL_ENDPOINT_SECRET_ACCESS_KEY = "DUMMYEXAMPLEKEY";

/** Region used when none is configured, or when the placeholder is configured. */
export const DEFAULT_REGION = "us-east-1";

export interface DynamoClientSource {
  endpoint?: string | null;
  region?: string | null;
  accessKeyId?: string | null;
  secretAccessKey?: string | null;
}

/**
 * A configured value is only real if it is non-empty and is not the "local"
 * placeholder that `config.ts` supplies for unset environment variables.
 */
function realValue(value: string | null | undefined): string | undefined {
  if (!value) return undefined;
  if (value === CONFIG_PLACEHOLDER) return undefined;
  return value;
}

function sourceFromConfig(): DynamoClientSource {
  return {
    endpoint: config.dynamoDbEndpoint,
    region: config.awsRegion,
    accessKeyId: config.awsAccessKeyId,
    secretAccessKey: config.awsSecretAccessKey,
  };
}

/**
 * Build the `DynamoDBClientConfig` for the current environment.
 *
 * Exported separately from `makeDynamoClient` so callers that need a different
 * SDK wrapper (e.g. the `DynamoDB` aggregated client) share the same precedence.
 */
export function buildDynamoClientConfig(
  source: DynamoClientSource = sourceFromConfig()
): DynamoDBClientConfig {
  const endpoint = realValue(source.endpoint);
  const accessKeyId = realValue(source.accessKeyId);
  const secretAccessKey = realValue(source.secretAccessKey);

  const clientConfig: DynamoDBClientConfig = {
    region: realValue(source.region) || DEFAULT_REGION,
  };

  if (endpoint) {
    clientConfig.endpoint = endpoint;
    clientConfig.credentials = {
      accessKeyId: LOCAL_ENDPOINT_ACCESS_KEY_ID,
      secretAccessKey: LOCAL_ENDPOINT_SECRET_ACCESS_KEY,
    };
    logger.info(`Using local DynamoDB at endpoint: ${endpoint}`);
    return clientConfig;
  }

  if (accessKeyId && secretAccessKey) {
    clientConfig.credentials = { accessKeyId, secretAccessKey };
    logger.info("Using production DynamoDB with AWS credentials");
    return clientConfig;
  }

  // No endpoint and no real keys: let the SDK resolve an identity itself.
  logger.info("Using default AWS credential provider chain");
  return clientConfig;
}

/** Construct a `DynamoDBClient` with the shared credential precedence. */
export function makeDynamoClient(source?: DynamoClientSource): DynamoDBClient {
  return new DynamoDBClient(buildDynamoClientConfig(source));
}

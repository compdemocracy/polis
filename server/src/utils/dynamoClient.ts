import { DynamoDBClient, DynamoDBClientConfig } from "@aws-sdk/client-dynamodb";
import config from "../config";
import logger from "./logger";

/**
 * Shared DynamoDB configuration. Explicit pairs retain precedence; otherwise
 * the SDK default chain resolves credentials, including instance-role sessions.
 * An endpoint selects transport only. Local development supplies credentials
 * explicitly through example.env, just like other S3/SES/DynamoDB clients.
 * Legacy "local" placeholders remain rejected when present in the environment.
 */

/** Legacy configuration placeholder, retained only for validation. */
export const CONFIG_PLACEHOLDER = "local";

/** Region used when none is configured, or when the placeholder is configured. */
export const DEFAULT_REGION = "us-east-1";

/** Error code reported when the environment holds a placeholder credential. */
export const PLACEHOLDER_CREDENTIALS_ERROR_CODE =
  "polis_err_aws_credentials_placeholder";

/**
 * Thrown instead of building a client whose credentials the AWS SDK would
 * resolve from a placeholder left in the environment. Carries a stable
 * `code` so routes can report it without string-matching the message.
 */
export class AwsCredentialsConfigurationError extends Error {
  readonly code = PLACEHOLDER_CREDENTIALS_ERROR_CODE;

  constructor(message: string) {
    super(message);
    this.name = "AwsCredentialsConfigurationError";
    // Required for `instanceof` to work when compiled below ES2015.
    Object.setPrototypeOf(this, AwsCredentialsConfigurationError.prototype);
  }
}

export interface DynamoClientSource {
  endpoint?: string | null;
  region?: string | null;
  accessKeyId?: string | null;
  secretAccessKey?: string | null;
}

/** Just the environment entries the AWS SDK's `fromEnv` provider reads. */
export interface DynamoClientEnv {
  AWS_ACCESS_KEY_ID?: string;
  AWS_SECRET_ACCESS_KEY?: string;
  // Index signature so `process.env` (NodeJS.ProcessEnv) is assignable.
  [key: string]: string | undefined;
}

/**
 * A configured value is only real if it is non-empty and is not the "local"
 * legacy placeholder.
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
 * Names of the environment variables that are set to the placeholder literal.
 *
 * Only these two matter: they are what the SDK's environment credential
 * provider reads once we omit `credentials`.
 */
function placeholdersInEnv(env: DynamoClientEnv): string[] {
  const names: string[] = [];
  if (env.AWS_ACCESS_KEY_ID === CONFIG_PLACEHOLDER) {
    names.push("AWS_ACCESS_KEY_ID");
  }
  if (env.AWS_SECRET_ACCESS_KEY === CONFIG_PLACEHOLDER) {
    names.push("AWS_SECRET_ACCESS_KEY");
  }
  return names;
}

/**
 * Build the `DynamoDBClientConfig` for the current environment.
 *
 * Exported separately from `makeDynamoClient` so callers that need a different
 * SDK wrapper (e.g. the `DynamoDB` aggregated client) share the same precedence.
 *
 * @throws {AwsCredentialsConfigurationError} when the default credential chain
 * would be used but the environment holds the "local" placeholder, which the
 * chain's environment provider would pick up. See the contract above.
 */
export function buildDynamoClientConfig(
  source: DynamoClientSource = sourceFromConfig(),
  // Inspect the live environment the default provider will read.
  // eslint-disable-next-line no-restricted-properties
  env: DynamoClientEnv = process.env
): DynamoDBClientConfig {
  const endpoint = realValue(source.endpoint);
  const accessKeyId = realValue(source.accessKeyId);
  const secretAccessKey = realValue(source.secretAccessKey);

  const clientConfig: DynamoDBClientConfig = {
    region: realValue(source.region) || DEFAULT_REGION,
  };

  if (endpoint) {
    clientConfig.endpoint = endpoint;
    logger.info(`Using DynamoDB at endpoint: ${endpoint}`);
  }

  if (accessKeyId && secretAccessKey) {
    clientConfig.credentials = { accessKeyId, secretAccessKey };
    logger.info("Using production DynamoDB with AWS credentials");
    return clientConfig;
  }

  // About to fall back to the default chain. If the placeholder is actually
  // present in the environment, the chain's environment provider would resolve
  // it and send it to AWS, so refuse to build the client instead.
  const placeholders = placeholdersInEnv(env);
  if (placeholders.length > 0) {
    const message =
      `${placeholders.join(" and ")} ` +
      `${placeholders.length > 1 ? "are" : "is"} set to the placeholder ` +
      `"${CONFIG_PLACEHOLDER}". The AWS SDK's default credential chain would ` +
      `read that value from the environment and send it to AWS. Set real ` +
      `credentials explicitly for local development, or unset ` +
      `these variables so the default credential provider chain (the EC2 ` +
      `instance role) can be used.`;
    logger.error(`${PLACEHOLDER_CREDENTIALS_ERROR_CODE}: ${message}`);
    throw new AwsCredentialsConfigurationError(message);
  }

  // No endpoint, no real keys, no placeholder in the environment: let the SDK
  // resolve an identity itself.
  logger.info("Using default AWS credential provider chain");
  return clientConfig;
}

/**
 * Construct a `DynamoDBClient` with the shared credential precedence.
 *
 * @throws {AwsCredentialsConfigurationError} see {@link buildDynamoClientConfig}.
 * Nothing is constructed when it throws.
 */
export function makeDynamoClient(
  source?: DynamoClientSource,
  env?: DynamoClientEnv
): DynamoDBClient {
  return new DynamoDBClient(buildDynamoClientConfig(source, env));
}

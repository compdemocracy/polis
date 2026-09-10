import { DynamoDBClient, DynamoDBClientConfig } from "@aws-sdk/client-dynamodb";
import config from "../config";
import logger from "./logger";

/**
 * Shared DynamoDB client construction.
 *
 * Every DynamoDB client in the server must resolve credentials the same way:
 *
 *   1. `DYNAMODB_ENDPOINT` set  -> DynamoDB Local. Send public-fixture credentials;
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
 *
 * ## The contract on the placeholder, stated precisely
 *
 * Filtering the placeholder out of the *options object* is not by itself enough
 * to keep it away from AWS, and the two cases must be distinguished:
 *
 *   - **`AWS_ACCESS_KEY_ID` genuinely unset.** `config.ts` invents "local"
 *     internally; the environment holds nothing. Dropping `credentials` hands
 *     the SDK a clean default chain, which reaches the instance role. This is
 *     the production incident this module was written for, and it is safe.
 *
 *   - **`AWS_ACCESS_KEY_ID` explicitly set to the literal "local".** Omitting
 *     `credentials` does *not* remove it: the default chain's own environment
 *     provider (`fromEnv`) re-reads `process.env` after our filtering and
 *     resolves `accessKeyId="local"` anyway. Silently filtering here would
 *     promise more than it delivers.
 *
 * So in the second case this module refuses to build a client at all and throws
 * {@link AwsCredentialsConfigurationError} (`polis_err_aws_credentials_placeholder`)
 * before construction — a named configuration error at the call site rather than
 * an opaque `UnrecognizedClientException` from AWS later. The alternative,
 * scrubbing `process.env` or installing a custom provider chain, would change
 * credential resolution for every other AWS client in the process, which this
 * module has no business doing.
 *
 * The check applies only when the default chain would otherwise be used. Local
 * endpoint mode (branch 1) and an explicitly supplied real pair (branch 2) never
 * consult the environment provider, so neither is affected.
 *
 * "Placeholder" means exactly the literal {@link CONFIG_PLACEHOLDER}. No attempt
 * is made to judge whether an arbitrary key *looks* valid; a real credential is
 * never rejected.
 *
 * ## Known limitation: `AWS_SESSION_TOKEN`
 *
 * An explicitly configured pair (branch 2) carries no session token, so static
 * credentials are supported but temporary ones are not. This is inherited, not
 * new: `config.ts` does not read `AWS_SESSION_TOKEN` and none of the other
 * eleven DynamoDB clients in `server/src/` pass one either. Temporary
 * credentials belong on the default chain (branch 3), which resolves the token
 * itself. Adding token passthrough would be a change to every client's
 * behaviour and is deliberately out of scope here.
 */

/** Literal that `config.ts` substitutes for unset AWS environment variables. */
export const CONFIG_PLACEHOLDER = "local";

/** Credentials used against DynamoDB Local; not valid anywhere else. */
export const LOCAL_ENDPOINT_ACCESS_KEY_ID = "DUMMYIDEXAMPLE";
export const LOCAL_ENDPOINT_SECRET_ACCESS_KEY = "DUMMYEXAMPLEKEY";

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
  // `process.env` rather than `config.ts` on purpose: this must mirror exactly
  // what the SDK's environment credential provider reads, at the moment it
  // would read it. `config.ts` snapshots the environment at module load and
  // rewrites an unset value to the "local" placeholder, which erases the very
  // distinction this guard exists to make.
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
      `credentials, set DYNAMODB_ENDPOINT for local development, or unset ` +
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

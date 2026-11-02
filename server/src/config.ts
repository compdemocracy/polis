/* eslint-disable no-restricted-properties */
import fs from "node:fs";
import isTrue from "boolean";

const devHostname: string = process.env.API_DEV_HOSTNAME || "localhost:5000";
const devMode: boolean = isTrue(process.env.DEV_MODE);
const domainOverride: string | null = process.env.DOMAIN_OVERRIDE || null;
const prodHostname: string = process.env.API_PROD_HOSTNAME || "pol.is";
const serverPort: number = parseInt(
  process.env.API_SERVER_PORT || process.env.PORT || "5000",
  10
);
const shouldUseTranslationAPI: boolean = isTrue(
  process.env.SHOULD_USE_TRANSLATION_API
);
// P-038. When true, `globalErrorHandler` is additionally mounted AFTER the
// router, which is the only position from which it can see errors handed to
// `next(err)` by a route (Express 3 walks the app stack forward only).
// Default OFF: turning it on changes served bytes on every error that reaches
// finalhandler today (status, Content-Type and body all change; app.ts,
// where the handler is mounted, lists which paths change). The flag exists
// so the characterization harness can re-record the difference before anyone
// decides to adopt it.
const reachableErrorHandler: boolean = isTrue(
  process.env.POLIS_REACHABLE_ERROR_HANDLER
);

import("source-map-support").then((sourceMapSupport) => {
  sourceMapSupport.install();
});

export default {
  // Delphi readers remain on DynamoDB unless explicitly selected. Keep these
  // reads at the shared configuration boundary, including test-time selection.
  get delphiResultBackend(): string | undefined { return process.env.DELPHI_RESULT_BACKEND; },
  get delphiResultEnv(): string | undefined { return process.env.DELPHI_RESULT_ENV; },
  get delphiResultScope(): string | undefined { return process.env.DELPHI_RESULT_SCOPE; },
  get delphiWriterCodeSha(): string | undefined { return process.env.DELPHI_WRITER_CODE_SHA; },
  domainOverride,
  isDevMode: devMode,
  reachableErrorHandler,
  serverPort,

  getServerNameWithProtocol: (req: any): string => {
    if (devMode) {
      // usually localhost:5000
      return `${req.protocol}://${req.headers.host}`;
    }
    if (domainOverride) {
      return `${req.protocol}://${domainOverride}`;
    }
    if (req.headers.host.includes("preprod.pol.is")) {
      return "https://preprod.pol.is";
    }
    if (req.headers.host.includes("embed.pol.is")) {
      return "https://embed.pol.is";
    }
    if (req.headers.host.includes("survey.pol.is")) {
      return "https://survey.pol.is";
    }

    return `https://${prodHostname}`;
  },

  getServerHostname: (): string => {
    if (devMode) {
      return devHostname;
    }
    if (domainOverride) {
      return domainOverride;
    }
    return prodHostname;
  },

  getServerUrl: (): string => {
    if (devMode) {
      return `http://${devHostname}`;
    } else {
      return `https://${prodHostname}`;
    }
  },

  getValidTopicalRatio(): number | null {
    const raw = process.env.TOPICAL_COMMENT_RATIO;
    if (raw === undefined || raw === null || raw === "") return null;
    const val = parseFloat(raw);
    if (!Number.isFinite(val)) return null;
    if (val < 0 || val > 1) return null;
    return val;
  },

  adminEmailDataExport: process.env.ADMIN_EMAIL_DATA_EXPORT as string,
  adminEmailEmailTest: process.env.ADMIN_EMAIL_EMAIL_TEST as string,
  adminEmails: process.env.ADMIN_EMAILS || "[]",
  adminUIDs: process.env.ADMIN_UIDS || "[]",
  anthropicApiKey: process.env.ANTHROPIC_API_KEY || null,
  applicationName: process.env.APPLICATION_NAME || null,
  authAudience: process.env.AUTH_AUDIENCE || null,
  authDomain: process.env.AUTH_DOMAIN || process.env.AUTH0_DOMAIN || null,
  authClientId:
    process.env.AUTH_CLIENT_ID || process.env.AUTH0_CLIENT_ID || null,
  authClientSecret:
    process.env.AUTH_CLIENT_SECRET || process.env.AUTH0_CLIENT_SECRET || null,
  authIssuer: process.env.AUTH_ISSUER || null,
  authNamespace: process.env.AUTH_NAMESPACE || null,
  awsAccessKeyId: process.env.AWS_ACCESS_KEY_ID,
  awsRegion: process.env.AWS_REGION || ("local" as string),
  awsSecretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  cacheMathResults: isTrueOrBlank(process.env.CACHE_MATH_RESULTS),
  databaseSSL: isTrue(process.env.DATABASE_SSL),
  databaseURL: process.env.DATABASE_URL as string,
  ddEnv: process.env.DD_ENV as string,
  dynamoDbEndpoint: process.env.DYNAMODB_ENDPOINT || null,
  emailTransportTypes: process.env.EMAIL_TRANSPORT_TYPES || null,
  geminiApiKey: process.env.GEMINI_API_KEY || null,
  jwksUri: process.env.JWKS_URI || null,
  logLevel: process.env.SERVER_LOG_LEVEL as string,
  logToFile: isTrue(process.env.SERVER_LOG_TO_FILE),
  loginCodePepper:
    process.env.LOGIN_CODE_PEPPER ||
    process.env.ENCRYPTION_PASSWORD_00001 ||
    "polis_treevite_pepper",
  maxReportCacheDuration: parseInt(
    process.env.MAX_REPORT_CACHE_DURATION || "3600000",
    10
  ),
  mathEnv: process.env.MATH_ENV as string,
  nodeEnv: process.env.NODE_ENV as string,
  isTesting: isTrue(process.env.TESTING),
  openaiApiKey: process.env.OPENAI_API_KEY || null,
  // Protected operations pages (/api/v3/ops/*, /ops in the admin console).
  // Off unless OPS_ENABLED=true; see docs/configuration.md.
  opsEnabled: isTrue(process.env.OPS_ENABLED),
  opsEmailDomains: process.env.OPS_EMAIL_DOMAINS || "",
  // Conversations need at least this many distinct voters in the window before
  // the ops pages show their topic, Delphi topic names or statement text.
  // Raw string; parsed (default 20) by src/ops/textThreshold.ts.
  opsMinVotersForText: process.env.OPS_MIN_VOTERS_FOR_TEXT || "",
  // "aws": the ops system pages read CloudWatch, Auto Scaling and CodeDeploy
  // with the instance role. Anything else (the default): those panels are
  // left out and nothing is requested from AWS.
  opsDataSource: process.env.OPS_DATA_SOURCE || "",
  // Cost Explorer for the ops cost page (each request is billed $0.01). Off
  // unless set; read only when OPS_DATA_SOURCE=aws.
  opsCostExplorer: isTrue(process.env.OPS_COST_EXPLORER),
  // Ops "Where from" page: Simple Analytics Stats API key and the site name
  // the three web apps report under. Key unset: the page says so and reads
  // nothing.
  simpleAnalyticsApiKey: process.env.SIMPLE_ANALYTICS_API_KEY || "",
  simpleAnalyticsHostname: process.env.SIMPLE_ANALYTICS_HOSTNAME || "pol.is",
  polisFromAddress: process.env.POLIS_FROM_ADDRESS as string,
  polisJwtIssuer: process.env.POLIS_JWT_ISSUER || "https://pol.is/",
  polisJwtAudience: process.env.POLIS_JWT_AUDIENCE || "participants",
  // P-024 Postgres queue substrate, first slice. Default off, and never on in
  // production regardless of the variable: turning it on only makes
  // src/queue/enqueue.ts callable from dev/test code, it wires no route and
  // starts no worker. See docs/queue-substrate.md.
  queueSubstrateEnabled:
    process.env.NODE_ENV !== "production" &&
    isTrue(process.env.POLIS_QUEUE_SUBSTRATE_ENABLED),
  readOnlyDatabaseURL:
    process.env.READ_ONLY_DATABASE_URL || (process.env.DATABASE_URL as string),
  // The participation pools (db/pg-query.ts): votes, comments, the next
  // statement and participationInit, and nothing else. See
  // docs/configuration.md "Connection budget".
  // Their sizes; unset, each is sized like the read-write and read pools.
  participationPoolMax: poolSizeFromEnv("PARTICIPATION_POOL_MAX"),
  participationReadPoolMax: poolSizeFromEnv("PARTICIPATION_READ_POOL_MAX"),
  // How long a participation query waits for one of their connections (ms).
  // Far beyond any wait that participation work alone can cause, so it never
  // refuses a vote under load; it only surfaces a database that has stopped
  // answering. 0 waits without limit.
  participationAcquireTimeoutMs: millisecondsFromEnv(
    "PARTICIPATION_ACQUIRE_TIMEOUT_MS",
    60000
  ),
  // Reports, data exports and heavy admin reads run on a small dedicated pool
  // (db/pg-query.ts) so they can never take the connections the participation
  // path needs. See docs/configuration.md "Connection budget".
  // One at a time by default: further exports wait for the acquire timeout.
  reportExportPoolMax: parseInt(
    process.env.REPORT_EXPORT_POOL_MAX || "1",
    10
  ),
  // How long a report/export waits for one of those connections before it is
  // rejected (ms). It degrades itself here rather than waiting on, or spilling
  // into, the participation pools.
  reportExportAcquireTimeoutMs: parseInt(
    process.env.REPORT_EXPORT_ACQUIRE_TIMEOUT_MS || "30000",
    10
  ),
  // Per-statement cap on that pool (ms). Generous by default so today's largest
  // exports still succeed; streamed exports read their cursor in small batches,
  // so this bounds a single runaway statement, not a long stream.
  reportExportStatementTimeoutMs: parseInt(
    process.env.REPORT_EXPORT_STATEMENT_TIMEOUT_MS || "300000",
    10
  ),
  shouldUseTranslationAPI: setGoogleApplicationCredentials(),
  staticFilesAdminPort: parseInt(
    process.env.STATIC_FILES_ADMIN_PORT ||
      process.env.STATIC_FILES_PORT ||
      "8080",
    10
  ),
  staticFilesParticipationPort: parseInt(
    process.env.STATIC_FILES_PARTICIPATION_PORT ||
      process.env.STATIC_FILES_PORT ||
      "8080",
    10
  ),
  staticFilesHost: process.env.STATIC_FILES_HOST as string,
  useNetworkHost: isTrue(process.env.USE_NETWORK_HOST),
  DYNAMODB_ENDPOINT: process.env.DYNAMODB_ENDPOINT,
  AWS_REGION: process.env.AWS_REGION,
  AWS_ACCESS_KEY_ID: process.env.AWS_ACCESS_KEY_ID,
  AWS_SECRET_ACCESS_KEY: process.env.AWS_SECRET_ACCESS_KEY,
  AWS_S3_ENDPOINT: process.env.AWS_S3_ENDPOINT,
  AWS_S3_PUBLIC_ENDPOINT: process.env.AWS_S3_PUBLIC_ENDPOINT,
  AWS_S3_BUCKET_NAME: process.env.AWS_S3_BUCKET_NAME,
  AWS_S3_JOB_BUCKET_NAME: process.env.AWS_S3_JOB_BUCKET_NAME,
  SESEndpoint: process.env.SES_ENDPOINT,
  awsLogGroupName: process.env.AWS_LOG_GROUP_NAME || "docker",
  SQS_LOCAL_ENDPOINT: process.env.SQS_LOCAL_ENDPOINT,
  SQS_QUEUE_URL: process.env.SQS_QUEUE_URL,

  // JWT configuration
  jwtPrivateKeyPath:
    process.env.JWT_PRIVATE_KEY_PATH || "/app/keys/jwt-private.pem",
  jwtPublicKeyPath:
    process.env.JWT_PUBLIC_KEY_PATH || "/app/keys/jwt-public.pem",
  jwtPrivateKey: process.env.JWT_PRIVATE_KEY || null,
  jwtPublicKey: process.env.JWT_PUBLIC_KEY || null,

  whitelistItems: [
    process.env.DOMAIN_WHITELIST_ITEM_01 || null,
    process.env.DOMAIN_WHITELIST_ITEM_02 || null,
    process.env.DOMAIN_WHITELIST_ITEM_03 || null,
    process.env.DOMAIN_WHITELIST_ITEM_04 || null,
    process.env.DOMAIN_WHITELIST_ITEM_05 || null,
    process.env.DOMAIN_WHITELIST_ITEM_06 || null,
    process.env.DOMAIN_WHITELIST_ITEM_07 || null,
    process.env.DOMAIN_WHITELIST_ITEM_08 || null,
  ].filter((item) => item !== null) as string[],

  // Deprecated
  encryptionPassword: process.env.ENCRYPTION_PASSWORD_00001 as string,
};

// A whole number of milliseconds from the environment, or `fallback` when the
// variable is unset or blank. Anything else stops the server at startup, so a
// mistyped bound can never silently leave a pool unbounded.
function millisecondsFromEnv(name: string, fallback: number): number {
  const raw = (process.env[name] ?? "").trim();
  if (raw === "") return fallback;
  if (!/^\d+$/.test(raw)) {
    throw new Error(
      `${name} must be a whole number of milliseconds (0 turns it off); got '${raw}'`
    );
  }
  return parseInt(raw, 10);
}

// A pool size from the environment, or undefined when the variable is unset or
// blank, so the pool takes its default size. Anything but a whole number of at
// least 1 stops the server at startup.
function poolSizeFromEnv(name: string): number | undefined {
  const raw = (process.env[name] ?? "").trim();
  if (raw === "") return undefined;
  if (!/^\d+$/.test(raw) || parseInt(raw, 10) < 1) {
    throw new Error(
      `${name} must be a whole number of at least 1; got '${raw}'`
    );
  }
  return parseInt(raw, 10);
}

// Use this function when a value should default to true if not set.
function isTrueOrBlank(val: string | boolean | undefined): boolean {
  return val === undefined || val === "" || isTrue(val);
}

function setGoogleApplicationCredentials(): boolean {
  if (!shouldUseTranslationAPI) {
    return false;
  }

  const googleCredentialsBase64: string | undefined =
    process.env.GOOGLE_CREDENTIALS_BASE64;
  const googleCredsStringified: string | undefined =
    process.env.GOOGLE_CREDS_STRINGIFIED;

  try {
    // TODO: Consider deprecating GOOGLE_CREDS_STRINGIFIED in future.
    if (!googleCredentialsBase64 && !googleCredsStringified) {
      throw new Error(
        "Missing Google credentials. Translation API will be disabled."
      );
    }

    const creds_string = googleCredentialsBase64
      ? Buffer.from(googleCredentialsBase64, "base64").toString("ascii")
      : (googleCredsStringified as string);

    // Tell translation library where to find credentials, and write them to disk.
    const credentialsFilePath = ".google_creds_temp";
    process.env.GOOGLE_APPLICATION_CREDENTIALS = credentialsFilePath;
    fs.writeFileSync(credentialsFilePath, creds_string);

    return true;
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error(error);
    return false;
  }
}

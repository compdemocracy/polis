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

import("source-map-support").then((sourceMapSupport) => {
  sourceMapSupport.install();
});

export default {
  domainOverride,
  isDevMode: devMode,
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
  adminEmailDataExportTest: process.env.ADMIN_EMAIL_DATA_EXPORT_TEST as string,
  adminEmailEmailTest: process.env.ADMIN_EMAIL_EMAIL_TEST as string,
  adminEmails: process.env.ADMIN_EMAILS || "[]",
  adminUIDs: process.env.ADMIN_UIDS || "[]",
  akismetAntispamApiKey: process.env.AKISMET_ANTISPAM_API_KEY || null,
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
  awsAccessKeyId: process.env.AWS_ACCESS_KEY_ID || ("local" as string),
  awsRegion: process.env.AWS_REGION || ("local" as string),
  awsSecretAccessKey: process.env.AWS_SECRET_ACCESS_KEY || ("local" as string),
  backfillCommentLangDetection: isTrue(
    process.env.BACKFILL_COMMENT_LANG_DETECTION
  ),
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
  mailgunApiKey: process.env.MAILGUN_API_KEY || null,
  mailgunDomain: process.env.MAILGUN_DOMAIN || null,
  maxReportCacheDuration: parseInt(
    process.env.MAX_REPORT_CACHE_DURATION || "3600000",
    10
  ),
  mathEnv: process.env.MATH_ENV as string,
  nodeEnv: process.env.NODE_ENV as string,
  isTesting: isTrue(process.env.TESTING),
  openaiApiKey: process.env.OPENAI_API_KEY || null,
  polisFromAddress: process.env.POLIS_FROM_ADDRESS as string,
  polisJwtIssuer: process.env.POLIS_JWT_ISSUER || "https://pol.is/",
  polisJwtAudience: process.env.POLIS_JWT_AUDIENCE || "participants",
  readOnlyDatabaseURL:
    process.env.READ_ONLY_DATABASE_URL || (process.env.DATABASE_URL as string),
  runPeriodicExportTests: isTrue(process.env.RUN_PERIODIC_EXPORT_TESTS),
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
  webserverPass: process.env.WEBSERVER_PASS as string,
  webserverUsername: process.env.WEBSERVER_USERNAME as string,
};

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

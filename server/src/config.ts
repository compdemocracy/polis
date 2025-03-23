/* eslint-disable no-restricted-properties */
import fs from "fs";
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

  adminEmailDataExport: process.env.ADMIN_EMAIL_DATA_EXPORT as string,
  adminEmailDataExportTest: process.env.ADMIN_EMAIL_DATA_EXPORT_TEST as string,
  adminEmailEmailTest: process.env.ADMIN_EMAIL_EMAIL_TEST as string,
  adminEmails: process.env.ADMIN_EMAILS || "[]",
  adminUIDs: process.env.ADMIN_UIDS || "[]",
  akismetAntispamApiKey: process.env.AKISMET_ANTISPAM_API_KEY || null,
  anthropicApiKey: process.env.ANTHROPIC_API_KEY || null,
  applicationName: process.env.APPLICATION_NAME || null,
  awsAccessKeyId: process.env.AWS_ACCESS_KEY_ID || 'local' as string,
  awsRegion: process.env.AWS_REGION || 'local' as string,
  awsSecretAccessKey: process.env.AWS_SECRET_ACCESS_KEY || 'local' as string,
  backfillCommentLangDetection: isTrue(
    process.env.BACKFILL_COMMENT_LANG_DETECTION
  ),
  cacheMathResults: isTrueOrBlank(process.env.CACHE_MATH_RESULTS),
  databaseSSL: isTrue(process.env.DATABASE_SSL),
  databaseURL: process.env.DATABASE_URL as string,
  dynamoDbEndpoint: process.env.DYNAMODB_ENDPOINT || null,
  emailTransportTypes: process.env.EMAIL_TRANSPORT_TYPES || null,
  encryptionPassword: process.env.ENCRYPTION_PASSWORD_00001 as string,
  geminiApiKey: process.env.GEMINI_API_KEY || null,
  googleApiKey: process.env.GOOGLE_API_KEY || null,
  googleJigsawPerspectiveApiKey:
    process.env.GOOGLE_JIGSAW_PERSPECTIVE_API_KEY || null,
  logLevel: process.env.SERVER_LOG_LEVEL as string,
  logToFile: isTrue(process.env.SERVER_LOG_TO_FILE),
  mailgunApiKey: process.env.MAILGUN_API_KEY || null,
  mailgunDomain: process.env.MAILGUN_DOMAIN || null,
  maxReportCacheDuration: parseInt(process.env.MAX_REPORT_CACHE_DURATION || "3600000", 10),
  mathEnv: process.env.MATH_ENV as string,
  nodeEnv: process.env.NODE_ENV as string,
  openaiApiKey: process.env.OPENAI_API_KEY || null,
  polisFromAddress: process.env.POLIS_FROM_ADDRESS as string,
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
  webserverPass: process.env.WEBSERVER_PASS as string,
  webserverUsername: process.env.WEBSERVER_USERNAME as string,

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

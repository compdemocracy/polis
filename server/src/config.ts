import isTrue from "boolean";

const devHostname = process.env.API_DEV_HOSTNAME || "localhost:5000";
const devMode = isTrue(process.env.DEV_MODE) as boolean;
const domainOverride = process.env.DOMAIN_OVERRIDE || null as string | null;
const serverHostname = process.env.API_SERVER_HOSTNAME || "pol.is";
const serverPort = parseInt(process.env.API_SERVER_PORT || "5000", 10) as number;

export default {
  domainOverride: domainOverride as string | null,
  isDevMode: devMode as boolean,
  serverPort: serverPort as number,

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

    return `https://${serverHostname}`;
  },

  getServerHostname: (): string => {
    if (devMode) {
      return devHostname;
    }
    if (domainOverride) {
      return domainOverride;
    }
    return serverHostname;
  },

  getServerUrl: (): string => {
    if (devMode) {
      return `http://${devHostname}`;
    } else {
      return `https://${serverHostname}`;
    }
  },

  adminEmailDataExport: process.env.ADMIN_EMAIL_DATA_EXPORT as string,
  adminEmailDataExportTest: process.env.ADMIN_EMAIL_DATA_EXPORT_TEST as string,
  adminEmailEmailTest: process.env.ADMIN_EMAIL_EMAIL_TEST as string,
  adminEmails: process.env.ADMIN_EMAILS || '[]' as string,
  adminUIDs: process.env.ADMIN_UIDS || '[]' as string,
  akismetAntispamApiKey: process.env.AKISMET_ANTISPAM_API_KEY || null as string | null,
  awsRegion: process.env.AWS_REGION as string,
  backfillCommentLangDetection: isTrue(process.env.BACKFILL_COMMENT_LANG_DETECTION) as boolean,
  cacheMathResults: isTrue(process.env.CACHE_MATH_RESULTS) as boolean,
  databaseURL: process.env.DATABASE_URL as string,
  emailTransportTypes: process.env.EMAIL_TRANSPORT_TYPES || null as string | null,
  encryptionPassword: process.env.ENCRYPTION_PASSWORD_00001 as string,
  googleCredentialsBase64: process.env.GOOGLE_CREDENTIALS_BASE64 || null as string | null,
  googleCredsStringified: process.env.GOOGLE_CREDS_STRINGIFIED as string,
  logLevel: process.env.SERVER_LOG_LEVEL as string,
  mailgunApiKey: process.env.MAILGUN_API_KEY || (null as string | null),
  mailgunDomain: process.env.MAILGUN_DOMAIN || (null as string | null),
  mathEnv: process.env.MATH_ENV as string,
  maxmindLicenseKey: process.env.MAXMIND_LICENSE_KEY as string,
  maxmindUserID: process.env.MAXMIND_USER_ID as string,
  nodeEnv: process.env.NODE_ENV as string,
  polisFromAddress: process.env.POLIS_FROM_ADDRESS as string,
  readOnlyDatabaseURL: process.env.READ_ONLY_DATABASE_URL || process.env.DATABASE_URL as string,
  runPeriodicExportTests: isTrue(process.env.RUN_PERIODIC_EXPORT_TESTS) as boolean,
  shouldUseTranslationAPI: isTrue(process.env.SHOULD_USE_TRANSLATION_API) as boolean,
  staticFilesAdminPort: parseInt(process.env.STATIC_FILES_ADMIN_PORT || '8080', 10) as number,
  staticFilesClientPort: parseInt(process.env.STATIC_FILES_CLIENT_PORT || '8080', 10) as number,
  staticFilesHost: process.env.STATIC_FILES_HOST as string,
  twitterConsumerKey: process.env.TWITTER_CONSUMER_KEY || null as string | null,
  twitterConsumerSecret: process.env.TWITTER_CONSUMER_SECRET || null as string | null,
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
  ].filter(item => item !== null) as string[],
}

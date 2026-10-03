// OFFLINE=1 (or true) is for a box with no network. The server then skips the
// hosted services it would otherwise call. Each call site checks Config.offline
// itself; this module only decides what to announce, and announces it once at
// startup. Nothing here logs per request.

import Config from "../config";
import logger from "./logger";

type OfflineConfig = Pick<
  typeof Config,
  "offline" | "nodeEnv" | "SESEndpoint" | "shouldUseTranslationAPI"
>;

// dd-trace is initialised in production mode, but never when OFFLINE is set:
// with no agent to send to, the tracer only drops traces.
export function shouldInitTracer(config: OfflineConfig = Config): boolean {
  return config.nodeEnv === "production" && !config.offline;
}

// Email goes nowhere when OFFLINE is set and SES_ENDPOINT is unset, since the
// SDK would then reach real AWS. A set SES_ENDPOINT (for example ses-local)
// is a local inbox, so sends still go to it.
export function shouldSkipEmail(config: OfflineConfig = Config): boolean {
  return config.offline && !config.SESEndpoint;
}

// One line per skipped service, in the order they are announced.
export function offlineSkips(config: OfflineConfig = Config): string[] {
  if (!config.offline) {
    return [];
  }
  const skips = [
    "Auth0 Management API: isProConvo answers false (no pro moderation) without calling it",
    "Akismet: the startup key check is not run",
  ];
  if (config.nodeEnv === "production") {
    skips.push("dd-trace: the tracer is not initialised");
  }
  if (config.shouldUseTranslationAPI) {
    skips.push(
      "Google Translate: SHOULD_USE_TRANSLATION_API is ignored; comments are not translated or language-detected"
    );
  }
  if (shouldSkipEmail(config)) {
    skips.push(
      "SES: SES_ENDPOINT is unset, so email is not sent; each unsent message is logged at debug level"
    );
  }
  return skips;
}

let announced = false;

export function logOfflineSkips(config: OfflineConfig = Config): void {
  if (announced || !config.offline) {
    return;
  }
  announced = true;
  for (const skip of offlineSkips(config)) {
    logger.info(`OFFLINE: skipping ${skip}`);
  }
}

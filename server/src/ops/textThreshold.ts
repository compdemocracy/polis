// OPS_MIN_VOTERS_FOR_TEXT: the content threshold for the ops pages.
//
// The topics and consensus pages show a conversation's topic, its Delphi topic
// names and the text of chosen statements only when the conversation had at
// least this many distinct voters in the page's window. Below it the
// conversation is counted, never named. Default 20.
//
// A value that is not a whole number of at least 1 is refused: the pages use
// the default and the server logs one error naming the setting, so a typo can
// never lower the threshold.

import logger from "../utils/logger";

export const DEFAULT_MIN_VOTERS_FOR_TEXT = 20;

export function parseMinVotersForText(raw: string | null | undefined): {
  value: number;
  valid: boolean;
} {
  const text = (raw ?? "").trim();
  if (text === "") return { value: DEFAULT_MIN_VOTERS_FOR_TEXT, valid: true };
  if (!/^[0-9]+$/.test(text)) {
    return { value: DEFAULT_MIN_VOTERS_FOR_TEXT, valid: false };
  }
  const n = Number(text);
  if (!Number.isSafeInteger(n) || n < 1) {
    return { value: DEFAULT_MIN_VOTERS_FOR_TEXT, valid: false };
  }
  return { value: n, valid: true };
}

/** Parse once at start-up, logging an invalid value. */
export function minVotersForTextFromConfig(raw: string | null | undefined) {
  const parsed = parseMinVotersForText(raw);
  if (!parsed.valid) {
    logger.error("ops_config_invalid", {
      setting: "OPS_MIN_VOTERS_FOR_TEXT",
      using: parsed.value,
    });
  }
  return parsed.value;
}

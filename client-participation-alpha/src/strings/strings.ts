/**
 * @file Modernized internationalization (i18n) module.
 *
 * This module dynamically detects the user's preferred language from the browser settings
 * or a URL parameter, loads the appropriate translation file, and provides the strings
 * for the application. It uses English as a fallback for any missing translations.
 *
 * It also includes a utility function to help developers find missing translation keys.
 */

import { uiLanguage, uiLanguageSSR } from "../lib/lang"
import type { Translations } from "./types"

/**
 * A map of language codes to their corresponding dynamic import function.
 * This enables code-splitting, so only the required language file is fetched by the browser.
 * NOTE: This assumes your string files are located in `../strings/` relative to this file
 * and that they use `export default`.
 *
 * Example `ar.js`:
 * export default { "key": "value" };
 */
const translationModules: Record<string, () => Promise<{ default: Partial<Translations> }>> = {
  // Arabic
  ar: () => import("./ar"),
  // Bosnian
  bs: () => import("./bs"),
  // Burmese
  my: () => import("./my"),
  // Croatian
  hr: () => import("./hr"),
  // Welsh
  cy: () => import("./cy"),
  // Danish
  da: () => import("./da_dk"),
  // German
  de: () => import("./de_de"),
  // Greek
  el: () => import("./gr"),
  // English
  en_us: () => import("./en_us"),
  // Spanish
  es: () => import("./es_la"),
  // Farsi
  fa: () => import("./fa"),
  // French
  fr: () => import("./fr"),
  // Frisian
  fy: () => import("./fy_nl"),
  // Hebrew
  he: () => import("./he"),
  // Italian
  it: () => import("./it"),
  // Japanese
  ja: () => import("./ja"),
  // Dutch
  nl: () => import("./nl"),
  // Pashto
  ps: () => import("./ps"),
  // Brazilian Portuguese
  pt_br: () => import("./pt_br"),
  // Romanian & Moldovan
  ro: () => import("./ro"),
  // Russian
  ru: () => import("./ru"),
  // Slovak
  sk: () => import("./sk"),
  // Swahili
  sw: () => import("./sw"),
  // Tamil
  ta: () => import("./ta"),
  // Tetum (Timor)
  tdt: () => import("./tdt"),
  // Ukrainian
  uk: () => import("./uk"),
  // Vietnamese
  vi: () => import("./vi"),
  // Simplified Chinese
  zh_Hans: () => import("./zh_Hans"),
  // Traditional Chinese
  zh_Hant: () => import("./zh_Hant")
}

/**
 * Maps browser language codes (like 'en-US', 'pt-BR', 'zh-CN') to the
 * keys used in our `translationModules` object.
 */
export const languageMap: Record<string, string> = {
  en: "en_us",
  ja: "ja",
  "zh-CN": "zh_Hans",
  "zh-SG": "zh_Hans",
  "zh-MY": "zh_Hans",
  zh: "zh_Hant", // Fallback for general Chinese
  "zh-TW": "zh_Hant",
  it: "it",
  da: "da",
  de: "de",
  es: "es",
  fa: "fa",
  hr: "hr",
  fr: "fr",
  nl: "nl",
  sk: "sk",
  pt: "pt_br",
  "pt-PT": "pt_br",
  "pt-BR": "pt_br",
  he: "he",
  cy: "cy",
  el: "el",
  uk: "uk",
  ru: "ru",
  ro: "ro",
  ar: "ar",
  fy: "fy",
  ta: "ta",
  tdt: "tdt",
  my: "my",
  ps: "ps",
  sw: "sw",
  vi: "vi",
  bs: "bs"
}

/**
 * Normalizes a raw language code to match our translation module keys.
 * This is used internally by the translation loading system.
 *
 * @param langCode - Raw language code (e.g., "en-US", "pt-BR", "zh-CN")
 * @returns Normalized language code (e.g., "en_us", "pt_br", "zh_Hans") or null if not found
 */
function normalizeLanguageCode(langCode: string | null | undefined): string | null {
  if (!langCode) {
    return null
  }

  // Check for exact match first (e.g., "pt-BR" -> "pt_br")
  if (languageMap[langCode]) {
    return languageMap[langCode]
  }

  // Check for base language match (e.g., "pt" from "pt-BR")
  const baseLang = langCode.split("-")[0].toLowerCase()
  if (languageMap[baseLang]) {
    return languageMap[baseLang]
  }

  // Check for region-specific matches (e.g., "zh-CN" -> "zh_Hans")
  const parts = langCode.split("-")
  if (parts.length === 2) {
    const regionLang = `${parts[0]}-${parts[1]}`
    if (languageMap[regionLang]) {
      return languageMap[regionLang]
    }
  }

  return null
}

/**
 * Determines the best available translation module key based on user's preferred languages.
 * Uses uiLanguage() functions to detect the language, then normalizes it to a translation module key.
 *
 * @param queryParam - Optional: The value of the `ui_lang` query parameter (for SSR)
 * @param acceptLanguageHeader - Optional: The value of the Accept-Language header (for SSR)
 * @returns {string|null} The key for the best-matching language module (e.g., 'pt_br'), or null if no match is found.
 */
function getTargetLanguageCode(
  queryParam?: string | null,
  acceptLanguageHeader?: string | null
): string | null {
  // Detect raw language code using appropriate method
  let rawLang: string | null = null

  if (typeof window === "undefined") {
    // SSR context: use SSR function if parameters provided
    if (queryParam !== undefined || acceptLanguageHeader !== undefined) {
      rawLang = uiLanguageSSR(queryParam ?? null, acceptLanguageHeader ?? null)
    }
  } else {
    // Client context: use client function
    rawLang = uiLanguage()
  }

  // If no language detected, return null (will default to English in getTranslations)
  if (!rawLang) {
    return null
  }

  // Normalize the detected language code to a translation module key
  const normalized = normalizeLanguageCode(rawLang)
  if (normalized && translationModules[normalized]) {
    return normalized
  }

  return null
}

let translationsStore: Translations | null = null

/**
 * Asynchronously loads and returns the translation strings.
 * It fetches the English strings as a base and merges the user's preferred language on top.
 * Results are cached after the first call.
 *
 * @param queryParam - Optional: The value of the `ui_lang` query parameter (for SSR)
 * @param acceptLanguageHeader - Optional: The value of the Accept-Language header (for SSR)
 * @returns {Promise<Translations>} A promise that resolves to the final strings object.
 *
 * @example
 * ```typescript
 * // Client-side (auto-detects):
 * const s = await getTranslations()
 *
 * // SSR (pass context):
 * const s = await getTranslations(
 *   Astro.url.searchParams.get('ui_lang'),
 *   Astro.request.headers.get('accept-language')
 * )
 * ```
 */
export async function getTranslations(
  queryParam?: string | null,
  acceptLanguageHeader?: string | null
): Promise<Translations> {
  // Only use cache on client side to avoid sharing state between requests on server
  if (typeof window !== "undefined" && translationsStore) {
    return translationsStore
  }

  try {
    // 1. Always load English as the default/fallback.
    const { default: enStrings } = await translationModules.en_us()
    // Cast to Translations since en_us is our source of truth for the interface
    const finalStrings = { ...(enStrings as Translations) }

    // 2. Determine the user's preferred language.
    const targetCode = getTargetLanguageCode(queryParam, acceptLanguageHeader)

    // 3. If a different language is found, load it and merge it over the English default.
    if (targetCode && targetCode !== "en_us") {
      const { default: targetStrings } = await translationModules[targetCode]()
      Object.assign(finalStrings, targetStrings) // Merges target strings, overwriting English keys.
    }

    if (typeof window !== "undefined") {
      translationsStore = finalStrings
    }
    return finalStrings
  } catch (error) {
    console.error("I18n Error: Could not load translation files.", error)
    // Fallback to an empty object or handle error appropriately
    return {} as Translations
  }
}

/**
 * A developer utility to find and display missing translation keys for all languages.
 * This function directly manipulates the DOM to show a report.
 */
export async function findMissingTranslations(): Promise<void> {
  if (typeof document === "undefined") {
    console.log("This utility must be run in a browser environment.")
    return
  }

  document.body.innerHTML =
    '<pre style="font-family: monospace; white-space: pre-wrap; word-wrap: break-word;"></pre>'
  const pre = document.body.querySelector("pre")
  if (!pre) return

  pre.innerHTML = "<h1>Missing Translation Keys Report</h1>"

  try {
    const { default: enStrings } = await translationModules.en_us()
    const enKeys = Object.keys(enStrings)

    for (const code in translationModules) {
      if (code === "en_us") continue

      const { default: targetStrings } = await translationModules[code]()
      // Type cast to allow indexing by string since Partial<Translations> might not cover it
      const ts = targetStrings as Record<string, string | undefined>

      const missingKeys = enKeys.filter((key) => ts[key] === undefined)

      if (missingKeys.length > 0) {
        let report = `<h2>${code} (${missingKeys.length} missing)</h2>`
        missingKeys.forEach((key) => {
          // Sanitizing the string to prevent HTML injection
          // Use type assertion to safe record type
          const value = (enStrings as Record<string, string | undefined>)[key]
          if (value) {
            const safeString = value.replace(/"/g, "&quot;")
            report += `<div>s.${key} = "${safeString}";</div>`
          }
        })
        pre.insertAdjacentHTML("beforeend", report)
      }
    }
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : String(error)
    pre.insertAdjacentHTML(
      "beforeend",
      `<h2>An error occurred during the process.</h2><p>${errorMessage}</p>`
    )
    console.error("Error finding missing translations:", error)
  }
}

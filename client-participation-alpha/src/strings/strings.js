// Copyright (C) 2012-present, The Authors. This program is free software: you can redistribute it and/or modify it under the terms of the GNU Affero General Public License, version 3, as published by the Free Software Foundation. This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU Affero General Public License for more details. You should have received a copy of the GNU Affero General Public License along with this program.  If not, see <http://www.gnu.org/licenses/>.

/**
 * @file Modernized internationalization (i18n) module.
 *
 * This module dynamically detects the user's preferred language from the browser settings
 * or a URL parameter, loads the appropriate translation file, and provides the strings
 * for the application. It uses English as a fallback for any missing translations.
 *
 * It also includes a utility function to help developers find missing translation keys.
 */

/**
 * A map of language codes to their corresponding dynamic import function.
 * This enables code-splitting, so only the required language file is fetched by the browser.
 * NOTE: This assumes your string files are located in `../strings/` relative to this file
 * and that they use `export default`.
 *
 * Example `ar.js`:
 * export default { "key": "value" };
 */
const translationModules = {
  // Arabic
  ar: () => import('./ar.js'),
  // Bosnian
  bs: () => import('./bs.js'),
  // Burmese
  my: () => import('./my.js'),
  // Croatian
  hr: () => import('./hr.js'),
  // Welsh
  cy: () => import('./cy.js'),
  // Danish
  da: () => import('./da_dk.js'),
  // German
  de: () => import('./de_de.js'),
  // Greek
  el: () => import('./gr.js'),
  // English
  en_us: () => import('./en_us.js'),
  // Spanish
  es: () => import('./es_la.js'),
  // Farsi
  fa: () => import('./fa.js'),
  // French
  fr: () => import('./fr.js'),
  // Frisian
  fy: () => import('./fy_nl.js'),
  // Hebrew
  he: () => import('./he.js'),
  // Italian
  it: () => import('./it.js'),
  // Japanese
  ja: () => import('./ja.js'),
  // Dutch
  nl: () => import('./nl.js'),
  // Pashto
  ps: () => import('./ps.js'),
  // Brazilian Portuguese
  pt_br: () => import('./pt_br.js'),
  // Romanian & Moldovan
  ro: () => import('./ro.js'),
  // Russian
  ru: () => import('./ru.js'),
  // Slovak
  sk: () => import('./sk.js'),
  // Swahili
  sw: () => import('./sw.js'),
  // Tamil
  ta: () => import('./ta.js'),
  // Tetum (Timor)
  tdt: () => import('./tdt.js'),
  // Ukrainian
  uk: () => import('./uk.js'),
  // Vietnamese
  vi: () => import('./vi.js'),
  // Simplified Chinese
  zh_Hans: () => import('./zh_Hans.js'),
  // Traditional Chinese
  zh_Hant: () => import('./zh_Hant.js'),
};

/**
 * Maps browser language codes (like 'en-US', 'pt-BR', 'zh-CN') to the
 * keys used in our `translationModules` object.
 */
const languageMap = {
  'en': 'en_us',
  'ja': 'ja',
  'zh-CN': 'zh_Hans',
  'zh-SG': 'zh_Hans',
  'zh-MY': 'zh_Hans',
  'zh': 'zh_Hant', // Fallback for general Chinese
  'zh-TW': 'zh_Hant',
  'it': 'it',
  'da': 'da',
  'de': 'de',
  'es': 'es',
  'fa': 'fa',
  'hr': 'hr',
  'fr': 'fr',
  'nl': 'nl',
  'sk': 'sk',
  'pt': 'pt_br',
  'pt-PT': 'pt_br',
  'pt-BR': 'pt_br',
  'he': 'he',
  'cy': 'cy',
  'el': 'el',
  'uk': 'uk',
  'ru': 'ru',
  'ro': 'ro',
  'ar': 'ar',
  'fy': 'fy',
  'ta': 'ta',
  'tdt': 'tdt',
  'my': 'my',
  'ps': 'ps',
  'sw': 'sw',
  'vi': 'vi',
  'bs': 'bs',
};


/**
 * Gets the user's preferred languages from the browser or a URL parameter.
 * @returns {string[]} An array of language codes, ordered by preference.
 */
export function getPreferredLanguages() {
  if (typeof window === 'undefined') {
    return ['en_us']; // Default for server-side rendering
  }
  const params = new URLSearchParams(window.location.search);
  const langOverride = params.get('ui_lang');
  if (langOverride) {
    return [langOverride];
  }
  return navigator.languages || [navigator.language];
}

/**
 * Determines the best available translation module key based on user's preferred languages.
 * @returns {string|null} The key for the best-matching language module (e.g., 'pt_br'), or null if no match is found.
 */
function getTargetLanguageCode() {
  const preferredLanguages = getPreferredLanguages();

  for (const lang of preferredLanguages) {
    // Check for an exact match first (e.g., 'pt-BR')
    if (languageMap[lang] && translationModules[languageMap[lang]]) {
      return languageMap[lang];
    }
    // Check for a partial match (e.g., 'pt' from 'pt-BR')
    const baseLang = lang.split('-')[0];
    if (languageMap[baseLang] && translationModules[languageMap[baseLang]]) {
      return languageMap[baseLang];
    }
  }
  return null; // No suitable language found
}

let translationsStore = null;

/**
 * Asynchronously loads and returns the translation strings.
 * It fetches the English strings as a base and merges the user's preferred language on top.
 * Results are cached after the first call.
 *
 * @returns {Promise<{[key: string]: string}>} A promise that resolves to the final strings object.
 */
export async function getTranslations() {
  if (translationsStore) {
    return translationsStore;
  }

  try {
    // 1. Always load English as the default/fallback.
    const { default: enStrings } = await translationModules.en_us();
    let finalStrings = { ...enStrings };

    // 2. Determine the user's preferred language.
    const targetCode = getTargetLanguageCode();

    // 3. If a different language is found, load it and merge it over the English default.
    if (targetCode && targetCode !== 'en_us') {
      const { default: targetStrings } = await translationModules[targetCode]();
      Object.assign(finalStrings, targetStrings); // Merges target strings, overwriting English keys.
    }

    translationsStore = finalStrings;
    return translationsStore;
  } catch (error) {
    console.error("I18n Error: Could not load translation files.", error);
    // Fallback to an empty object or handle error appropriately
    return {};
  }
}


/**
 * A developer utility to find and display missing translation keys for all languages.
 * This function directly manipulates the DOM to show a report.
 */
export async function findMissingTranslations() {
  if (typeof document === 'undefined') {
    console.log("This utility must be run in a browser environment.");
    return;
  }

  document.body.innerHTML = '<pre style="font-family: monospace; white-space: pre-wrap; word-wrap: break-word;"></pre>';
  const pre = document.body.querySelector('pre');
  pre.innerHTML = '<h1>Missing Translation Keys Report</h1>';

  try {
    const { default: enStrings } = await translationModules.en_us();
    const enKeys = Object.keys(enStrings);

    for (const code in translationModules) {
      if (code === 'en_us') continue;

      const { default: targetStrings } = await translationModules[code]();
      const missingKeys = enKeys.filter(key => targetStrings[key] === undefined);

      if (missingKeys.length > 0) {
        let report = `<h2>${code} (${missingKeys.length} missing)</h2>`;
        missingKeys.forEach(key => {
          // Sanitizing the string to prevent HTML injection
          const safeString = enStrings[key].replace(/"/g, '&quot;');
          report += `<div>s.${key} = "${safeString}";</div>`;
        });
        pre.insertAdjacentHTML('beforeend', report);
      }
    }
  } catch (error) {
    pre.insertAdjacentHTML('beforeend', `<h2>An error occurred during the process.</h2><p>${error.message}</p>`);
    console.error("Error finding missing translations:", error);
  }
}

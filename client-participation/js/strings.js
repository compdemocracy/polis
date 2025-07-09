// Copyright (C) 2012-present, The Authors. This program is free software: you can redistribute it and/or  modify it under the terms of the GNU Affero General Public License, version 3, as published by the Free Software Foundation. This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU Affero General Public License for more details. You should have received a copy of the GNU Affero General Public License along with this program.  If not, see <http://www.gnu.org/licenses/>.

var preloadHelper = require("./util/preloadHelper");
var Utils = require("./util/utils");
var _ = require("lodash");

var translations = {
  // Arabic
  ar: require("./strings/ar.js"),
  // Bosnian
  bs: require("./strings/bs.js"),
  // Burmese
  my: require("./strings/my.js"),
  // Croatian
  hr: require("./strings/hr.js"),
  // Welsh
  cy: require("./strings/cy.js"),
  // Danish
  da: require("./strings/da_dk.js"),
  // German
  de: require("./strings/de_de.js"),
  // Greek
  el: require("./strings/gr.js"),
  // English
  en_us: require("./strings/en_us.js"),
  // Spanish
  es: require("./strings/es_la.js"),
  // Farsi
  fa: require("./strings/fa.js"),
  // French
  fr: require("./strings/fr.js"),
  // Frisian
  fy: require("./strings/fy_nl.js"),
  // Hebrew
  he: require("./strings/he.js"),
  // Italian
  it: require("./strings/it.js"),
  // Japanese
  ja: require("./strings/ja.js"),
  // Dutch
  nl: require("./strings/nl.js"),
  // Portuguese
  // Brazilian Portuguese (all portuguese speakers are temporarily using the same file.)
  pt_br: require("./strings/pt_br.js"),
  ps: require("./strings/ps.js"),
  // Portuguese (Timor-Leste)
  // pt_tl: require("./strings/pt_tl.js"),
  // Romanian & Moldovan
  ro: require("./strings/ro.js"),
  // Russian
  ru: require("./strings/ru.js"),
  // Slovak
  sk: require("./strings/sk.js"),
  // Swahili
  sw: require("./strings/sw.js"),
  // Tamil
  ta: require("./strings/ta.js"),
  // Tetum (Timor)
  tdt: require("./strings/tdt.js"),
  // Ukrainian
  uk: require("./strings/uk.js"),
  // Vietnamese
  vi: require("./strings/vi.js"),
  // Chinese
  // zh-Hans is Simplified Chinese. (CN, SG and MY can use the same file.)
  zh_Hans: require("./strings/zh_Hans.js"),
  // Chinese (Taiwan)
  // zh-Hant is Traditional Chinese (TW, MO and HK can use the same file.)
  zh_Hant: require("./strings/zh_Hant.js")
};

var strings = translations.en_us;

preloadHelper.acceptLanguagePromise.then(function () {
  var acceptLanguage = preload.acceptLanguage || "";
  var uiLang = Utils.uiLanguage();
  if (uiLang) {
    acceptLanguage = uiLang;
  }

  var prioritized = acceptLanguage.split(";");
  prioritized = prioritized[0].split(",");
  prioritized = prioritized || [];
  prioritized.reverse();

  prioritized.forEach(function (languageCode) {
    if (languageCode.match(/^en/)) {
      _.extend(strings, translations.en_us);
    } else if (languageCode.match(/^ja/)) {
      _.extend(strings, translations.ja);
    } else if (languageCode.match(/^zh-CN/) || languageCode.match(/^zh-SG/) || languageCode.match(/^zh-MY/)) {
      _.extend(strings, translations.zh_Hans);
    } else if (languageCode.match(/^zh/) || languageCode.match(/^zh-TW/)) {
      _.extend(strings, translations.zh_Hant);
    } else if (languageCode.match(/^it/)) {
      _.extend(strings, translations.it);
    } else if (languageCode.match(/^da/)) {
      _.extend(strings, translations.da);
    } else if (languageCode.match(/^de/)) {
      _.extend(strings, translations.de);
    } else if (languageCode.match(/^es/)) {
      _.extend(strings, translations.es);
    } else if (languageCode.match(/^fa/)) {
      _.extend(strings, translations.fa);
    } else if (languageCode.match(/^hr/)) {
      _.extend(strings, translations.hr);
    } else if (languageCode.match(/^fr/)) {
      _.extend(strings, translations.fr);
    } else if (languageCode.match(/^nl/)) {
      _.extend(strings, translations.nl);
    } else if (languageCode.match(/^sk/)) {
      _.extend(strings, translations.sk);
    } else if (
      languageCode.match(/^pt/) || // To help Portuguese participants until a specific translation is here
      languageCode.match(/^pt-PT/) || // To help Portuguese participants until a specific translation is here
      languageCode.match(/^pt-BR/)
    ) {
      _.extend(strings, translations.pt_br);
    } else if (languageCode.match(/^he/)) {
      _.extend(strings, translations.he);
    } else if (languageCode.match(/^cy/)) {
      _.extend(strings, translations.cy);
    } else if (languageCode.match(/^el/)) {
      _.extend(strings, translations.el);
    } else if (languageCode.match(/^uk/)) {
      _.extend(strings, translations.uk);
    } else if (languageCode.match(/^ru/)) {
      _.extend(strings, translations.ru);
    } else if (languageCode.match(/^ro/)) {
      _.extend(strings, translations.ro);
    } else if (languageCode.match(/^ar/)) {
      _.extend(strings, translations.ar);
    } else if (languageCode.match(/^fy/)) {
      _.extend(strings, translations.fy);
    } else if (languageCode.match(/^ta/)) {
      _.extend(strings, translations.ta);
    } else if (languageCode.match(/^tdt/)) {
      _.extend(strings, translations.tdt);
    } else if (languageCode.match(/^my/)) {
      _.extend(strings, translations.my);
    } else if (languageCode.match(/^ps/)) {
      _.extend(strings, translations.ps);
    } else if (languageCode.match(/^sw/)) {
      _.extend(strings, translations.sw);
    } else if (languageCode.match(/^vi/)) {
      _.extend(strings, translations.vi);
    } else if (languageCode.match(/^bs/)) {
      _.extend(strings, translations.bs);
    }
  });
});

window.missingTranslations = function () {
  $(document.body).empty();
  var pre = $(document.body).append("<pre></pre>");

  _.each(translations, function (keyToTranslatedStringMapping, code) {
    pre.append("<h2>" + code + "</h2>");
    _.each(translations.en_us, function (originalString, key) {
      if (!keyToTranslatedStringMapping[key]) {
        pre.append("<div>" + "s." + key + ' = "' + originalString + '";' + "</div>");
      }
    });
  });
  return missingKeys;
};

module.exports = strings;

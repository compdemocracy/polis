// Copyright (C) 2012-present, The Authors. This program is free software: you can redistribute it and/or  modify it under the terms of the GNU Affero General Public License, version 3, as published by the Free Software Foundation. This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU Affero General Public License for more details. You should have received a copy of the GNU Affero General Public License along with this program.  If not, see <http://www.gnu.org/licenses/>.

var preloadHelper = require("./util/preloadHelper");
var Utils = require("./util/utils");

var translations = {
  en_us: require("./strings/en_us.js"),
  // ja:  require("./strings/ja.js"),

  // zh-Hant is Traditional Chinese (TW, MO and HK can use the same file.)
  zh_Hant: require("./strings/zh_Hant.js"),

  // zh-Hans is Simplified Chinese. (CN, SG and MY can use the same file.)
  zh_Hans: require("./strings/zh_Hans.js"),

  // Danish
  da: require("./strings/da_dk.js"),

  // German
  de: require("./strings/de_de.js"),

  // Spanish
  es: require("./strings/es_la.js"),

  // French
  fr: require("./strings/fr.js"),

  // Italian
  it: require("./strings/it.js"),

  // Dutch
  nl: require("./strings/nl.js"),

  // Brazilian Portuguese (all portuguese speakers are temporarily using the same file.)
  pt_br: require("./strings/pt_br.js"),

  // Japanese
  ja: require("./strings/ja.js")
};



var strings = translations.en_us;

preloadHelper.acceptLanguagePromise.then(function() {
  var acceptLanguage = preload.acceptLanguage || "";
  var uiLang = Utils.uiLanguage();
  if (uiLang) {
    acceptLanguage = uiLang;
  }

  var prioritized = acceptLanguage.split(";");
  prioritized = prioritized[0].split(",");
  prioritized = prioritized || [];
  prioritized.reverse();


  prioritized.forEach(function(languageCode) {
    if (languageCode.match(/^en/)) {
      _.extend(strings, translations.en_us);
    }
    else if (languageCode.match(/^ja/)) {
      strings = _.extend(strings, translations.ja);
    }
    else if (
      languageCode.match(/^zh-CN/) ||
      languageCode.match(/^zh-SG/) ||
      languageCode.match(/^zh-MY/)) {
      _.extend(strings, translations.zh_Hans);
    }
    else if (languageCode.match(/^zh/)) { // TW, MO and HK
      _.extend(strings, translations.zh_Hant);
    }
    else if (languageCode.match(/^it/)) {
      _.extend(strings, translations.it);
    }
    else if (languageCode.match(/^da/)) {
      _.extend(strings, translations.da);
    }
    else if (languageCode.match(/^de/)) {
      _.extend(strings, translations.de);
    }
    else if (languageCode.match(/^es/)) {
      _.extend(strings, translations.es);
    }
    else if (languageCode.match(/^fr/)) {
      _.extend(strings, translations.fr);
    }
    else if (languageCode.match(/^nl/)) {
      _.extend(strings, translations.nl);
    }
    else if (
      languageCode.match(/^pt/) ||  // To help other Portuguese speaker participants until its specific translation is not here
      languageCode.match(/^pt-PT/) ||  // To help Portuguese participantes until an specific translation is not here
      languageCode.match(/^pt-BR/)) {
      _.extend(strings, translations.pt_br);
    }
  });
});

window.missingTranslations = function() {
  $(document.body).empty();
  var pre = $(document.body).append("<pre></pre>");

  _.each(translations, function(keyToTranslatedStringMapping, code) {
    pre.append("<h2>" + code + "</h2>");
    _.each(translations.en_us, function(originalString, key) {
      if (!keyToTranslatedStringMapping[key]) {
        pre.append("<div>" + 's.' + key + ' = "' + originalString + '";' + "</div>");
      }
    });
  });
  return missingKeys;
};

module.exports = strings;

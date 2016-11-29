// Copyright (C) 2012-present, Polis Technology Inc. This program is free software: you can redistribute it and/or  modify it under the terms of the GNU Affero General Public License, version 3, as published by the Free Software Foundation. This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU Affero General Public License for more details. You should have received a copy of the GNU Affero General Public License along with this program.  If not, see <http://www.gnu.org/licenses/>.

var preloadHelper = require("./util/preloadHelper");

var en_us = require("./strings/en_us.js");
// var ja = require("./strings/ja.js");

// zh-Hant is Traditional Chinese (TW, MO and HK can use the same file.)
var zh_Hant = require("./strings/zh_Hant.js");

// zh-Hans is Simplified Chinese. (CN, SG and MY can use the same file.)
var zh_Hans = require("./strings/zh_Hans.js");

// Spanish
var es = require("./strings/es_la.js");

// French
var fr = require("./strings/fr.js");

// Italian
var it = require("./strings/it.js");

// Brazilian Portuguese (all portuguese speakers are temporarily using the same file.)
var pt_br = require("./strings/pt_br.js");

var strings = en_us;

preloadHelper.acceptLanguagePromise.then(function() {
  var acceptLanguage = preload.acceptLanguage || "";

  var prioritized = acceptLanguage.split(";");
  prioritized = prioritized[0].split(",");
  prioritized = prioritized || [];
  prioritized.reverse();


  prioritized.forEach(function(languageCode) {
    if (languageCode.match(/^en/)) {
      _.extend(strings, en_us);
    }
    // else if (languageCode.match(/^ja/)) {
    //   strings = _.extend(strings, ja);
    // }
    else if (
      languageCode.match(/^zh-CN/) ||
      languageCode.match(/^zh-SG/) ||
      languageCode.match(/^zh-MY/)) {
      _.extend(strings, zh_Hans);
    }
    else if (languageCode.match(/^zh/)) { // TW, MO and HK
      _.extend(strings, zh_Hant);
    }
    else if (languageCode.match(/^it/)) {
      _.extend(strings, it);
    }
    else if (languageCode.match(/^es/)) {
      _.extend(strings, es);
    }
    else if (languageCode.match(/^fr/)) {
      _.extend(strings, fr);
    }
    else if (
      languageCode.match(/^pt/) ||  // To help other Portuguese speaker participants until its specific translation is not here
      languageCode.match(/^pt-PT/) ||  // To help Portuguese participantes until an specific translation is not here
      languageCode.match(/^pt-BR/)) {
      _.extend(strings, pt_br);
    }
  });
});


module.exports = strings;



var en_us = require("./strings/en_us.js");
var ja = require("./strings/ja.js");

// zh-Hant is Traditional Chinese (TW, MO and HK can use the same file.)
var zh_Hant = require("./strings/zh_Hant.js");

// zh-Hans is Simplified Chinese. (CN, SG and MY can use the same file.)
var zh_Hans = require("./strings/zh_Hans.js");

var acceptLanguage = preload.acceptLanguage || "";

var strings = en_us;

var prioritized = acceptLanguage.split(";");
prioritized = prioritized[0].split(",");
prioritized = prioritized || [];
prioritized.reverse();


prioritized.forEach(function(languageCode) {
	if (languageCode.match(/^en/)) {
		strings = _.extend(strings, en_us);
	}
	else if (languageCode.match(/^ja/)) {
		strings = _.extend(strings, ja);
	}
	else if (
		languageCode.match(/^zh-CN/) ||
		languageCode.match(/^zh-SG/) ||
		languageCode.match(/^zh-MY/)) {
		strings = _.extend(strings, zh_Hans);
	}
	else if (languageCode.match(/^zh/)) { // TW, MO and HK
		strings = _.extend(strings, zh_Hant);
	}
});

module.exports = strings;
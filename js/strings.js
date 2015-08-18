

var en_us = require("./strings/en_us.js");
var ja = require("./strings/ja.js");
var zh = require("./strings/zh.js");
var zh_CN = require("./strings/zh_CN.js");

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
	else if (languageCode.match(/^zh-CN/)) {
		strings = _.extend(strings, zh_CN);
	}
	else if (languageCode.match(/^zh/)) {
		strings = _.extend(strings, zh);
	}
});

module.exports = strings;
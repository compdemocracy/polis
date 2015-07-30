

var en_us = require("./strings/en_us.js");
var jp_jp = require("./strings/jp_jp.js");


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
	// else if (languageCode.match(/^ja/)) {
	// 	strings = _.extend(strings, jp_jp);
	// }
});

module.exports = strings;
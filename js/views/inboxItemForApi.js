var Handlebones = require("handlebones");
var template = require("../tmpl/inbox-item");

module.exports = Handlebones.ModelView.extend({
	template: template
});

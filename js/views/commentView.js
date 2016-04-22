var Handlebones = require("handlebones");
var template = require("../tmpl/commentView");

module.exports = Handlebones.ModelView.extend({
	name: "commentView",
	template: template
});

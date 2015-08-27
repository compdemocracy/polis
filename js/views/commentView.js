var Handlebones = require("handlebones");
var template = require("../tmpl/commentView");
var CommentModel = require("../models/comment");


module.exports = Handlebones.ModelView.extend({
	name: "commentView",
	template: template
});
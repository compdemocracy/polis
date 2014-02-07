var View = require("../view"); 
var template = require("../tmpl/commentView");
var CommentModel = require("../models/comment");


module.exports = View.extend({
	name: "commentView",
	template: template
});
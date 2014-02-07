var View = require("./view"); 
var template = require("./templates/commentView");
var CommentModel = require("./models/comment");

modules.exports = View.extend({
	name: "commentView",
	template: template
});
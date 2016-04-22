var Collection = require("../collection");
var Comment = require("../models/comment");

module.exports = Collection.extend({
  name: "comments",
  url: "comments",
  model: Comment
});

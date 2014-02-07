var Collection = require("../collection");
var MetadataAnswer = require("../models/metadataAnswer");

module.exports = Collection.extend({
  name: "metadata/answers",
  url: "metadata/answers",
  initialize: function(models, options) {
      this.zid = options.zid;
      this.pmqid = options.pmqid;
  },
  model: MetadataAnswer
});
var Collection = require("../collection");
var MetadataQuestion = require("../models/metadataQuestion");

module.exports = Collection.extend({
    name: "metadata/questions",
    url: "metadata/questions",
    initialize: function(models, options) {
        this.sid = options.sid;
    },
    comparator: function(a, b) {
      // ascending
      return a.get("created") - b.get("created");
    },
    model: MetadataQuestion
  });
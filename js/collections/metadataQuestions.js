var Collection = require("../collection");
var MetadataQuestion = require("../models/metadataQuestion");

module.exports = Collection.extend({
    name: "metadata/questions",
    url: "metadata/questions",
    initialize: function(models, options) {
        this.conversation_id = options.conversation_id;
    },
    comparator: function(a, b) {
      // ascending
      return a.get("created") - b.get("created");
    },
    model: MetadataQuestion
  });
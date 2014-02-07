var Collection = require("../collection");
var MetadataQuestion = require("../models/metadataQuestion");

module.exports = Collection.extend({
    name: "metadata/questions",
    url: "metadata/questions",
    initialize: function(models, options) {
        this.zid = options.zid;
    },
    model: MetadataQuestion
  });
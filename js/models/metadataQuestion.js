var MetadataAnswersCollection = require("../collections/metadataAnswers");
var Model = require("../model");

module.exports = Model.extend({
    name: "metadata/key",
  urlRoot: "metadata/questions",
  idAttribute: "pmqid",
  defaults: {
      // key: "No metadata question was entered. This is the default value of the model.",
      // required: false,
  },
  initialize: function() {
      var zid = this.get("zid");
      var pmqid = this.get("pmqid");
      this.collection = new MetadataAnswersCollection([], {
          zid: zid,
          pmqid: pmqid
      });
      var params = {
              zid: zid,
              pmqid: pmqid
          };
      if (this.suzinvite) {
        params.suzinvite = this.suzinvite;
      }
      if (this.zinvite) {
        params.zinvite = this.zinvite;
      }
      this.collection.fetch({
          data: $.param(params),
          processData: true
      });
  } // end initialize
});
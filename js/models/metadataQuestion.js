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
  updateAnswers: function() {
    var pmqid = this.get("pmqid");
    var zid = this.get("zid");
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
  },
  initialize: function() {
    // this.on("change:pmqid", this.updateAnswers.bind(this));
    // this.on("sync", this.updateAnswers.bind(this));
    this.on("add", this.updateAnswers.bind(this));
    // this.on("change", this.updateAnswers.bind(this));
    this.collection = new MetadataAnswersCollection([], {
    });
  } // end initialize
});
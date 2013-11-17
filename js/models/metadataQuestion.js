define([
    "collections/metadataAnswers",
    "model"
], function (
    MetadataAnswersCollection,
    Model) {
return Model.extend({
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
        this.collection.fetch({
            data: $.param({
                zid: zid,
                pmqid: pmqid
            }),
            processData: true
        });
    } // end initialize
  });
});

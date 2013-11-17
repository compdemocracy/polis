define([
    "collection",
    "models/metadataAnswer"
], function (
    Collection,
    MetadataAnswer
) {
  return Collection.extend({
    name: "metadata/answers",
    url: "metadata/answers",
    initialize: function(models, options) {
        this.zid = options.zid;
        this.pmqid = options.pmqid;
    },
    model: MetadataAnswer
  });
});

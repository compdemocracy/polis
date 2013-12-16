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
    model: MetadataAnswer
  });
});

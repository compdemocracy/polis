define([
    'collection',
    'models/metadataQuestion'
], function (
    Collection,
    MetadataQuestion
) {
  return Collection.extend({
    name: 'metadata/questions',
    url: 'metadata/questions',
    initialize: function(models, options) {
        this.zid = options.zid;
    },
    model: MetadataQuestion
  });
});

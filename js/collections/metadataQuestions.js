define([
    'collection',
    'models/metadataQuestion'
], function (
    Collection,
    MetadataQuestion
) {
  return Collection.extend({
    name: 'metadata/keys',
    url: 'metadata/keys',
    initialize: function(models, options) {
        this.zid = options.zid;
    },
    model: MetadataQuestion
  });
});

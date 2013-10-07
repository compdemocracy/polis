define([
    'collection',
    'models/metadataQuestion'
], function (
    Collection,
    metadataQuestion
) {
  return Collection.extend({
    name: 'metadata/keys',
    initialize: function(models, options) {
        this.zid = options.zid;
    },
    url: function() {
        return this.name;
    },
    model: metadataQuestion
  });
});

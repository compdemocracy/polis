define([
    'collection',
    'models/metadata'
], function (
    Collection,
    Metadata
) {
  return Collection.extend({
    name: 'metadata/keys',
    initialize: function(models, options) {
        this.zid = options.zid;
    },
    url: function() {
        return this.name;
    },
    model: Metadata
  });
});

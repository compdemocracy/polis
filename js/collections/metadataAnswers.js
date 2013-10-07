define([
    'collection',
    'models/metadataAnswer'
], function (
    Collection,
    MetadataAnswer
) {
  return Collection.extend({
    name: 'metadata/values',
    initialize: function(models, options) {
        this.zid = options.zid;
        this.pmkid = options.pmkid;
        this.checked = "checked"; // TODO would be nice to use a boolean and have the template say "checked"
    },
    url: function() {
        return this.name;
    },
    model: MetadataAnswer
  });
});

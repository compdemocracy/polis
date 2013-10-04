define(['collection', 'models/metadata'], function (Collection, Metadata) {
  return Collection.extend({
    name: 'metadata',
    model: Metadata
  });
});

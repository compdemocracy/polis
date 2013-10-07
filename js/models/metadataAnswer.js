define([
    'model',
], function (Model) {
  return Model.extend({
    name: 'metadataAnswers',
    defaults: {
        pmvid: -1,
        zid: -1,
        pmkid: -1,
        value: "",
    }
  });
});




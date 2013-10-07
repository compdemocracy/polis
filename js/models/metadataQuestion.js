define([
    'collections/metadataAnswers',
    'model',
], function (
    MetadataAnswersCollection,
    Model) {
return Model.extend({
    name: 'metadata/key',
    url: 'metadata/keys',
    defaults: {
    	key: "No metadata question was entered. This is the default value of the model.",
    	required: false, 
    },
    initialize: function() {
        var zid = this.get('zid');
        var pmkid = this.get('pmkid');
        this.collection = new MetadataAnswersCollection([], {
            zid: zid,
            pmkid: pmkid,
        });
        this.collection.fetch({
            data: $.param({
                zid: zid,
                pmkid: pmkid,
            }), 
            processData: true
        });
    } // end initialize
  });
});

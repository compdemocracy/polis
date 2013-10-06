define([
    'model',
 //   'models/metadataAnswers',
], function (
    Model//,
    //MetadataAnswerModel
) {
  return Model.extend({
    name: 'metadata/key',
    defaults: {
    	key: "No metadata question was entered. This is the default value of the model.",
//    	answers: [new MetadataAnswerModel()],
    	required: false, 
    }
  });
});




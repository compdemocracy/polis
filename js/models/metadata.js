define(['model'], function (Model) {
  return Model.extend({
    name: 'metadata',
    defaults: {
    	question: "No metadata question was entered. This is the default value of the model.",
    	answers: [],
    	required: false
    }
  });
});




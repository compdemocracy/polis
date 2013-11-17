define([
  "templates/metadataAnswerChecked",
  "views/metadataAnswerView"
], function (
  template,
  MetadataAnswerView
) {

return MetadataAnswerView.extend({
  name: "metadataAnswerViewChecked",
  template: template
});

});

define([
  'templates/metadataAnswer',
  'view'
], function (
  template,
  View
) {

return View.extend({
  name: 'metadataAnswerView',
  template: template,
  initialize: function(options) {
      this.model = options.model;
      this.zid = options.zid;
  }
});

});

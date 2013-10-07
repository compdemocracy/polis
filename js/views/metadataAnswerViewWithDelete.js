define([
  'templates/metadataAnswerWithDelete',
  'view'
], function (
  template,
  View
) {

return View.extend({
  name: 'metadataAnswerViewWithDelete',
  template: template,
  allowDelete: true,
  initialize: function(options) {
      this.model = options.model;
      this.zid = options.zid;
  }
});

});

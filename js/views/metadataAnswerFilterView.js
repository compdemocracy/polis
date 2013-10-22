define([
  'templates/metadataAnswerFilter',
  'view'
], function (
  template,
  View
) {

return View.extend({
  name: 'metadataAnswerFilterView',
  tagName: 'button',
  className: 'btn ',
  template: template,
  allowDelete: false,
  toggle: function() {
    this.model.set("enabled", !this.model.get("enabled"));
  },
  initialize: function(options) {
      this.model = options.model;
      this.zid = options.zid;
  }
});

});

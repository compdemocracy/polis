define([
  "templates/metadataAnswerFilter",
  "view"
], function (
  template,
  View
) {

return View.extend({
  name: "metadataAnswerFilterView",
  tagName: "button",
  className: 'btn ',
  template: template,
  allowDelete: false,
  toggle: function() {
    this.model.set("disabled", !this.model.get("disabled"));
  },
  initialize: function(options) {
      this.model = options.model;
      this.zid = options.zid;
      this.model.set("disabled", false);
  }
});

});

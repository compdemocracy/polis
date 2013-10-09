define([
  'templates/metadataAnswerWithDelete',
  'net/bbDestroy',
  'view'
], function (
  template,
  bbDestroy,
  View
) {

return View.extend({
  name: 'metadataAnswerViewWithDelete',
  template: template,
  allowDelete: true,
  deleteAnswer: function() {
    this.model.destroy();
    // bbDestroy(this.model, {wait: true, data: $.param({zid: this.model.get('zid')})}).then(function() {
    //   // ok
    // }, function(err) {
    //   alert("couldn't delete answer");
    //   console.dir(arguments);
    // });
  },
  initialize: function(options) {
      this.model = options.model;
      this.zid = options.zid;
  }
});

});

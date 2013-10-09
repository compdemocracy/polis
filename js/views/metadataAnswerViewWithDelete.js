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
  deleteAnswer: function() {
    this.model.destroy().then(function() {
      // ok
    }, function(err) {
      alert("couldn't delete answer");
      console.dir(arguments);
    });
  },
  initialize: function(options) {
      this.model = options.model;
      this.zid = options.zid;
  }
});

});

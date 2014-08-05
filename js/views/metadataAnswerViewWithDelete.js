var template = require("../tmpl/metadataAnswerWithDelete");
var bbDestroy = require("../net/bbDestroy");
var Handlebones = require("handlebones");


module.exports = Handlebones.ModelView.extend({
  name: "metadataAnswerViewWithDelete",
  template: template,
  allowDelete: true,
  events: {
    "click .deleteAnswer": function() {
      this.model.destroy();
      // bbDestroy(this.model, {wait: true, data: $.param({conversation_id: this.model.get("conversation_id")})}).then(function() {
      //   // ok
      // }, function(err) {
      //   alert("couldn't delete answer");
      //   console.dir(arguments);
      // });
    },
  },
  initialize: function(options) {
    Handlebones.ModelView.prototype.initialize.apply(this, arguments);
    this.model = options.model;
    this.conversation_id = options.conversation_id;
  }
});
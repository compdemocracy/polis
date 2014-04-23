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
      // bbDestroy(this.model, {wait: true, data: $.param({zid: this.model.get("zid")})}).then(function() {
      //   // ok
      // }, function(err) {
      //   alert("couldn't delete answer");
      //   console.dir(arguments);
      // });
    },
  },
  initialize: function(options) {
    Handlebones.ModelView.prototypes.initialize.call(this);
    this.model = options.model;
    this.zid = options.zid;
  }
});
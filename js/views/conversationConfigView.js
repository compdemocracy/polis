var Handlebones = require("handlebones");
var template = require('../tmpl/conversationConfig');
var Utils = require("../util/utils");
var Constants = require("../util/constants");
var disappearingAlert = require("../util/polisAlert").disappearingAlert;
var serialize = require("../util/serialize");


module.exports =  Handlebones.ModelView.extend({
  name: "conversationConfigView",
  template: template,
  events: {
  "click #submitButton": "onFormChange"
  },
  onFormChange: function(e) {
    e.preventDefault();
    var that = this;

    serialize(this, function(attrs) {
      // attrs.is_active = Boolean(attrs.is_active);
      attrs.strict_moderation = that.$("#strictOn")[0].checked;
      attrs.write_type = that.$("#writeTypeOn")[0].checked ? 1 : 0;
      attrs.vis_type = that.$("#visTypeOn")[0].checked ? 1 : 0;

      attrs.conversation_id = that.model.get("conversation_id");
      var queryString = Utils.toQueryParamString(attrs);
      $.ajax({
        url: "/api/v3/conversations?" + queryString,
        type: "PUT",
      }).then(function() {
        disappearingAlert("Saved", 500).then(function() {
          window.location.reload();
        });
      }, function(err) {
        alert("error saving");
      });
    });

  },
  // context: function() {
  //   var ctx = Handlebones.ModelView.prototype.context.apply(this, arguments);
  //   ctx.created = new Date(Number(ctx.created));
  //   return ctx;
  // },
  initialize: function(options) {
    Handlebones.ModelView.prototype.initialize.apply(this, arguments);
    var that = this;
    var conversation_id = this.conversation_id = this.model.get("conversation_id");
  } // end initialize
});

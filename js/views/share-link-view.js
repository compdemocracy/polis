var View = require("../view");
var template = require("../tmpl/share-link-view");
var ConversationModel = require("../models/conversation");

module.exports = View.extend({
    name: "shareLinkView",
    template: template,
    model: ConversationModel,
    events: {
      "click #okButton": function() {
        this.trigger("done");
      },
      "mouseup input": function(event) {
        // :( http://stackoverflow.com/questions/3272089/programmatically-selecting-text-in-an-input-field-on-ios-devices-mobile-safari
        setTimeout(function() {
          if (event.target) {
            if (event.target.setSelectionRange) {
              event.target.setSelectionRange(0,9999999);
            } else {
              $(event.target).select();
            }
          }
        }, 1);
      }
    }
  });
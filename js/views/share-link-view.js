define([
  "view",
  "templates/share-link-view",
  "models/conversation"
], function (View, template, ConversationModel) {
  return View.extend({
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
            event.target.setSelectionRange(0,9999999);
          }
        }, 1);
      }
    }
  });
});

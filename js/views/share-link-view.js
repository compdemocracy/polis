var template = require("../tmpl/share-link-view");
var ConversationModel = require("../models/conversation");
var Handlebones = require("handlebones");

module.exports = Handlebones.ModelView.extend({
    name: "shareLinkView",
    template: template,
    model: ConversationModel,
    events: {
      "click #sendShareLinkToEmailButton": function(){
        //https://www.dropbox.com/s/f8ed1vtpim28aej/Screenshot%202014-03-02%2023.29.31.png 
        //owner was undefined on the client side, so going to server to make requests for that information and fire mailgun
        //if oid is on the client side, can send that instead of zid
        var zid=this.model.attributes.zid;
        $.ajax({
          type: "POST",
          dataType: "json",
          xhrFields: {
            withCredentials: true
          },
          crossDomain: true,
          url: "/v3/sendCreatedLinkToEmail",
          data: {
            zid: zid
          }
        }).done(function(){
          console.log('sent!')
        })
      },
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
    },
    initialize: function() {
      Handlebones.ModelView.prototype.initialize.apply(this, arguments);
      this.tweet_text = "Join the conversation!";
      // NOTE: showing the topic may result in people actually responsing with tweets instead of clicking the link.
      // var topic = this.model.get("topic");
      // if (topic) {
      //   this.tweet_text = topic + " - " + this.tweet_text;
      // }
    }
  });
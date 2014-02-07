var template = require("../templates/conversationGatekeeper");
//var UserCreateView = require(".views/userCreateView");
var MetadataQuestionsView = require("../views/metadataQuestionsView");
var MetadataQuestionCollection = require("../collections/MetadataQuestions");
var PolisStorage = require("../util/polisStorage");
var View = require("../view");

module.exports = View.extend({
  name: "conversationGatekeeper",
  template: template,
  events: {
    "submit form": function(event){
      var that = this;
      event.preventDefault();
      var urlPrefix = "https://www.polis.io/";
      if (-1 === document.domain.indexOf(".polis.io")) {
          urlPrefix = "http://localhost:5000/";
      }
      this.serialize(function(attrs, release){
        // pull out the for values for pmaid
        var numbers = _.chain(attrs).keys().map(Number).filter(function(num) {
          return !_.isNaN(num) && _.isNumber(num);
        }).value();
        // delete them from the hash
        numbers.forEach(function(num) {
          delete attrs[num];
        });
        // add the pmaid values as answers
        attrs.answers = numbers;
        // Incorporate options, like zinvite.
        attrs = $.extend(that.options || {}, attrs);
        $.ajax({
          url: urlPrefix + "v3/participants",
          type: "POST",
          dataType: "json",
          xhrFields: {
              withCredentials: true
          },
          // crossDomain: true,
          data: attrs
        }).then(function(data) {
          release();
          that.trigger("done");
        }, function(err) {
          release();
          console.dir(arguments);
          alert(err.responseText);
        });
      });
    }
  },
  initialize: function(options) {
    this.options = options;
    var zid = options.zid;
    var zinvite = options.zinvite;
    this.metadataCollection = new MetadataQuestionCollection([], {
      zid: zid
    });
    this.metadataCollection.fetch({
        data: $.param({
            zid: zid,
            zinvite: zinvite
        }),
        processData: true
    });
    this.metadataQuestionsView = new MetadataQuestionsView({
      collection: this.metadataCollection,
      zid: zid,
      zinvite: zinvite
    });
    // this.gatekeeperAuthView = new UserCreateView({
    //   zinvite: zinvite,
    // });
  }
});
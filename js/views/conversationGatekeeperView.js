var template = require("../tmpl/conversationGatekeeper");
//var UserCreateView = require(".views/userCreateView");
var MetadataQuestionsView = require("../views/metadataQuestionsView");
var MetadataQuestionCollection = require("../collections/MetadataQuestions");
var MetadataQuestion = require("../models/metadataQuestion");
var PolisStorage = require("../util/polisStorage");
var View = require("../view");

module.exports = View.extend({
  name: "conversationGatekeeper",
  template: template,
  events: {
    "submit form": function(event){
      var that = this;
      event.preventDefault();
      var urlPrefix = "https://pol.is/";
      if (-1 === document.domain.indexOf("pol.is")) {
          urlPrefix = "http://localhost:5000/";
      }
      this.serialize(function(attrs, release){
        // pull out the for values for pmaid

        var numbers = _.chain(attrs)
          .values()  // attrs is {pmqid: pmaid} or {pmqid: [pmaid]}. We only need to upload the pmaids.
          .flatten() // when !is_exclusive, you can get an array of pmaid for each pmqid
          .map(Number)
          .filter(function(num) {
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
        var url = urlPrefix + "v3/participants";
        if (this.options.suzinvite) {
          url = urlPrefix + "v3/joinWithSuzinvite";
        }

        $.ajax({
          url: url,
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
          console.error(err.responseText);
        });
      });
    }
  },
  initialize: function(options) {
    this.options = options;
    var zid = options.zid;
    var zinvite = options.zinvite;
    var suzinvite = options.suzinvite;
    var params = {
      zid: zid,
    };
    if (options.zinvite) {
      params.zinvite = options.zinvite;
    }
    if (options.suzinvite) {
      params.suzinvite = options.suzinvite;
    }

    var MetadataQuestionModelWithZinvite = MetadataQuestion.extend(params);

    this.metadataCollection = new MetadataQuestionCollection([], {
      model: MetadataQuestionModelWithZinvite,
      zid: zid
    });
    this.metadataCollection.fetch({
        data: $.param(params),
        processData: true
    });
    this.metadataQuestionsView = new MetadataQuestionsView({
      collection: this.metadataCollection,
      zinvite: zinvite,
      suzinvite: suzinvite,
      zid: zid
    });
    // this.gatekeeperAuthView = new UserCreateView({
    //   zinvite: zinvite,
    // });
  }
});
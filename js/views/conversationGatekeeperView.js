var template = require("../tmpl/conversationGatekeeper");
//var UserCreateView = require(".views/userCreateView");
var MetadataQuestionsView = require("../views/metadataQuestionsView");
var MetadataQuestionCollection = require("../collections/MetadataQuestions");
var MetadataQuestion = require("../models/metadataQuestion");
var PolisStorage = require("../util/polisStorage");
var Handlebones = require("handlebones");
var serialize = require("../util/serialize");

module.exports = Handlebones.ModelView.extend({
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
      serialize(this, function(attrs){
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

        var params = that.params;
        if (params.zinvite) {
          attrs.zinvite = params.zinvite;
        }
        if (params.suzinvite) {
          attrs.suzinvite = params.suzinvite;
        }
        attrs.zid = params.zid;

        var url = urlPrefix + "v3/participants";
        if (params.suzinvite || params.zinvite) {
          url = urlPrefix + "v3/joinWithInvite";
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
          that.trigger("done");
        }, function(err) {
          console.dir(arguments);
          console.error(err.responseText);
        });
      });
    }
  },
  initialize: function(options) {
    Handlebones.ModelView.prototype.initialize.apply(this, arguments);
    this.options = options;
    this.model = options.model;
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
    this.params = params;

    var MetadataQuestionModelWithZinvite = MetadataQuestion.extend(params);

    this.metadataCollection = new MetadataQuestionCollection([], {
      model: MetadataQuestionModelWithZinvite,
      zid: zid
    });
    this.metadataCollection.fetch({
        data: $.param(params),
        processData: true
    });
    this.metadataQuestionsView = this.addChild(new MetadataQuestionsView({
      collection: this.metadataCollection,
      zinvite: zinvite,
      suzinvite: suzinvite,
      zid: zid
    }));
    // this.gatekeeperAuthView = new UserCreateView({
    //   zinvite: zinvite,
    // });
  }
});
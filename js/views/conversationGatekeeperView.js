var template = require("../tmpl/conversationGatekeeper");
//var UserCreateView = require(".views/userCreateView");
var MetadataQuestionsView = require("../views/metadataQuestionsView");
var MetadataQuestionCollection = require("../collections/metadataQuestions");
var MetadataQuestion = require("../models/metadataQuestion");
var PolisStorage = require("../util/polisStorage");
var Handlebones = require("handlebones");
var serialize = require("../util/serialize");
var URLs = require("../util/url");

var urlPrefix = URLs.urlPrefix;

module.exports = Handlebones.ModelView.extend({
  name: "conversationGatekeeper",
  template: template,
  events: {
    "submit form": function(event){
      var that = this;
      event.preventDefault();
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
        if (params.conversation_id) {
          attrs.conversation_id = params.conversation_id;
        }
        if (params.suzinvite) {
          attrs.suzinvite = params.suzinvite;
        }
        attrs.conversation_id = params.conversation_id;

        var url = urlPrefix + "api/v3/participants";
        if (params.suzinvite || params.conversation_id) {
          url = urlPrefix + "api/v3/joinWithInvite";
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
    var conversation_id = options.conversation_id;
    var suzinvite = options.suzinvite;
    var params = {
      conversation_id: conversation_id,
    };
    if (options.conversation_id) {
      params.conversation_id = options.conversation_id;
    }
    if (options.suzinvite) {
      params.suzinvite = options.suzinvite;
    }
    this.params = params;

    var MetadataQuestionModelWithZinvite = MetadataQuestion.extend(params);

    this.metadataCollection = new MetadataQuestionCollection([], {
      model: MetadataQuestionModelWithZinvite,
      conversation_id: conversation_id
    });
    this.metadataCollection.fetch({
        data: $.param(params),
        processData: true
    });
    this.metadataQuestionsView = this.addChild(new MetadataQuestionsView({
      collection: this.metadataCollection,
      suzinvite: suzinvite,
      conversation_id: conversation_id
    }));
    // this.gatekeeperAuthView = new UserCreateView({
    //   zinvite: zinvite,
    // });
  }
});

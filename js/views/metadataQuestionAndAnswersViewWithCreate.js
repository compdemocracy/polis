var MetadataAnswer = require("../models/metadataAnswer");
var MetadataAnswerViewWithDelete = require("../views/metadataAnswerViewWithDelete");
var MetadataQuestionAndAnswersView = require("../views/metadataQuestionAndAnswersView");
var serialize = require("../util/serialize");


var CV = Handlebones.CollectionView.extend({
  tagName: "div",
  modelView: MetadataAnswerViewWithDelete
});


module.exports = MetadataQuestionAndAnswersView.extend({
  name: "metadataQuestionAndAnswersViewWithCreate",
  CollectionView: CV,
  events: {
    "blur .add_answer_form": "hideAddAnswerForm",
    "keypress input" : function(e) {
      if (e.which === 13) {
        e.preventDefault();
        this.hideAddAnswerForm();
      }
    },
    "click .deleteQuestion": function() {
      // TODO allow changing the metadata question. deleting the question is not ideal when they've entered a bunch of answers.
      this.model.destroy();
    }
  },
  hideAddAnswerForm: function() {
    var that = this;
    serialize(this, function(attrs){

      // Make sure the form isn't empty.
      if (attrs.answerInput && attrs.answerInput.length) {
        var zid = that.model.get("zid");
        var data = {
          zid: zid,
          pmqid: that.model.get("pmqid"),
          value: attrs.answerInput
        };
        var model = new MetadataAnswer(data);
        model.save().then(function() {

          that.$el.find("input").val("");
          that.$el.find("input").focus();

          that.answers.fetch({
            data: $.param({
              zid: zid,
              pmqid: that.model.get("pmqid")
            }),
            processData: true
          });
        }, function() {
          alert("failed");
        });
      }
      that.render();
    });
  },
  allowCreate: true,
  allowDelete: true
});
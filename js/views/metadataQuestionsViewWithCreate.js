var MetadataQuestion = require("../models/metadataQuestion");
var MetadataQuestionAndAnswersViewWithCreate = require("../views/metadataQuestionAndAnswersViewWithCreate");
var MetadataQuestionsView = require("../views/metadataQuestionsView");
var serialize = require("../util/serialize");


var CV = Handlebones.CollectionView.extend({
  tagName: "div",
  modelView: MetadataQuestionAndAnswersViewWithCreate
});


module.exports = MetadataQuestionsView.extend({
  name: "metadataQuestionsViewWithCreate",
  allowCreate: true,
  CollectionView: CV,
  events: {
    "blur .add_question_form": "hideAddQuestionForm",
    "keypress input": function(e) {
      if (e.which === 13) {
        e.preventDefault();
        this.hideAddQuestionForm();
      }
    }
  },
  hideAddQuestionForm: function() {
    var that = this;
    serialize(this, function(attrs){
      // Make sure the form isn't empty.
      if (attrs.questionInput && attrs.questionInput.length) {
        var data = {
          zid: that.zid,
          key: attrs.questionInput
        };
        var model = new MetadataQuestion(data);
        model.save().done(function() {
          that.$el.find("input").val("");
          that.$el.find("input").focus();
          //that.collection.add(model);
          that.collection.fetch({
            data: $.param({
              zid: that.zid,
            })//,
            // reset: true
          });
          // that.render();
        });
      } else {
        // that.render();
      }
    });
  }
});
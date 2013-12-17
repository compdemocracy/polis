define([
  "models/metadataQuestion",
  "views/metadataQuestionAndAnswersViewWithCreate",
  "views/metadataQuestionsView"
], function (
  MetadataQuestion,
  MetadataQuestionAndAnswersViewWithCreate,
  MetadataQuestionsView
) {
  return MetadataQuestionsView.extend({
    name: "metadataQuestionsViewWithCreate",
    itemView: MetadataQuestionAndAnswersViewWithCreate,
    allowCreate: true,
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
      this.serialize(function(attrs, release){

        // Make sure the form isn't empty.
        if (attrs.questionInput && attrs.questionInput.length) {
          var data = {
            zid: that.zid,
            key: attrs.questionInput
          };
          var model = new MetadataQuestion(data);

          model.save().done(function() {
            //that.collection.add(model);
            that.collection.fetch({
              data: $.param({
                zid: that.zid
              }),
              reset: true
            });
            that.render();
          });
        } else {
          this.render();
        }
      });
    },
    initialize: function(options) {
      var that = this;
      this.on("render", function() {
        setTimeout(function() {
          that.$el.find("input").focus();
        },0);
      });
    }
});
});

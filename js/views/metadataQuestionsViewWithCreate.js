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
      // "blur .add_question_form": "hideAddQuestionForm",
      "keypress input" : function(e) {
        if (e.which === 13) {
          e.preventDefault();
          this.hideAddQuestionForm();
        }
      }
    },
    initialize: function() {
      this.listenTo(this, "rendered", function(){
        this.focusOnForm();
      });
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
            that.$el.find("input").val("");

            that.collection.fetch({
              data: $.param({
                zid: that.zid
              })
            });
            // that.formActive = false;
            // that.render();
          });
        }
        //  else {
        //   // this.formActive = false;
        //   // this.render();
        // }
      });
    },
    focusOnForm: function() {
      this.$el.find("input").focus();
    }
});
});

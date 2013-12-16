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
      "blur .add_question_form": "hideAddQuestionForm"
    },
    initialize: function() {
      this.listenTo(this, "rendered", function(){
        this.showAddQuestionForm();
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
            //that.collection.add(model);
            that.collection.fetch({
              data: $.param({
                pmqid: model.get("pmqid"),
                zid: that.zid
              }),
              reset: true
            });
            that.formActive = false;
            // that.render();
          });
        } else {
          this.formActive = false;
          // this.render();
        }
      });
    },
    showAddQuestionForm: function(event) {
      this.formActive = true;
      var that = this;
      setTimeout(function() {
        that.$el.find("input").focus().keypress(function(e) {
          if (e.which === 13) {
            e.preventDefault();
            that.hideAddQuestionForm();
          }
        });
      },0);
    }
});
});

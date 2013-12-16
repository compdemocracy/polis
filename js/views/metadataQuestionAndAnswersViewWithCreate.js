define([
  "collections/metadataAnswers",
  "models/metadataAnswer",
  "views/metadataAnswerViewWithDelete",
  "views/metadataQuestionAndAnswersView"
], function (
  MetadataAnswers,
  MetadataAnswer,
  MetadataAnswerViewWithDelete,
  MetadataQuestionAndAnswersView
) {

return MetadataQuestionAndAnswersView.extend({
  name: "metadataQuestionAndAnswersViewWithCreate",
  itemView: MetadataAnswerViewWithDelete,
  events: {
    "blur .add_answer_form": "hideAddAnswerForm"
  },
  initialize: function(){
    this.listenTo(this, "rendered", function(){
      this.showAddAnswerForm();
    });
  },
  deleteQuestion: function() {
    // TODO allow changing the metadata question. deleting the question is not ideal when they've entered a bunch of answers.
    this.model.destroy();
    // .then(function() {
    //   // ok
    // }, function(err) {
    //   alert("couldn't delete question");
    //   console.dir(arguments);
    // });
  },
  showAddAnswerForm: function(event) {
    this.formActive = true;
    var that = this;
    setTimeout(function() {
      that.$el.find("input").focus().keypress(function(e) {
        if (e.which === 13) {
          e.preventDefault();
          that.hideAddAnswerForm();
        }
      });
    },0);
  },
  hideAddAnswerForm: function() {
    var that = this;
    this.serialize(function(attrs, release){

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

          if (!that.collection) {
              that.collection = new MetadataAnswers([], {
                zid: zid,
                pmqid: that.model.get("pmqid")
              });
          } else {
            that.collection.fetch();
          }
          model.fetch();
          release();
        }, function() {
          release();
          alert("failed");
        });
      }
      that.formActive = false;
      // that.render();
    });
  },
  allowCreate: true,
  allowDelete: true
});

});

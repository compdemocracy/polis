define([
  "models/metadataAnswer",
  "views/metadataAnswerViewWithDelete",
  "views/metadataQuestionAndAnswersView"
], function (
  MetadataAnswer,
  MetadataAnswerViewWithDelete,
  MetadataQuestionAndAnswersView
) {

return MetadataQuestionAndAnswersView.extend({
  name: "metadataQuestionAndAnswersViewWithCreate",
  itemView: MetadataAnswerViewWithDelete,
  events: {
    "blur .add_answer_form": "hideAddAnswerForm",
    "keypress input" : function(e) {
      if (e.which === 13) {
        e.preventDefault();
        this.hideAddAnswerForm();
      }
    }
  },
  // initialize: function() {
  //   var that = this;
  //   this.on("render", function() {
  //     setTimeout(function() {
  //       that.$el.find("input").focus();
  //     },0);
  //   });
  // },
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
  // showAddAnswerForm: function(event) {
  //   this.render();
  //   var that = this;
  //   setTimeout(function() {
  //     that.$el.find("input").focus();
  //   },0);
  // },
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

          that.$el.find("input").val("");
          that.$el.find("input").focus();

          that.collection.fetch({
            data: $.param({
              zid: zid,
              pmqid: that.model.get("pmqid")
            }),
            processData: true
          });
          model.fetch();
          release();
        }, function() {
          release();
          alert("failed");
        });
      }
      that.render();
    });
  },
  allowCreate: true,
  allowDelete: true
});

});

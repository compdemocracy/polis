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
    var zid = this.model.get("zid");
    var pmqid = this.model.get("pmqid");
    this.collection = this.model.collection;
    // this.collection = new MetadataAnswers([], {
    //   zid: zid,
    //   pmqid: pmqid
    // });
    // this.collection.fetch({
    //   data: $.param({
    //     zid: zid,
    //     pmqid: pmqid
    //   }),
    //   processData: true
    // });
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
    var zid = this.model.get("zid");
    var pmqid = this.model.get("pmqid");
    this.serialize(function(attrs, release){

      // Make sure the form isn't empty.
      if (attrs.answerInput && attrs.answerInput.length) {
       
        var data = {
          zid: zid,
          pmqid: pmqid,
          value: attrs.answerInput
        };
        var model = new MetadataAnswer(data);
        model.save().then(function() {
          that.$el.find("input").val("");
          that.collection.fetch({
            data: $.param({
              zid: zid,
              pmqid: pmqid
            }),
            processData: true
          });
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

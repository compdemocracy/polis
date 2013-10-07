define([
  'models/metadataAnswer',
  'views/metadataAnswerViewWithDelete',
  'views/metadataQuestionAndAnswersView',
], function (
  MetadataAnswer,
  MetadataAnswerViewWithDelete,
  MetadataQuestionAndAnswersView
) {

return MetadataQuestionAndAnswersView.extend({
  name: 'metadataQuestionAndAnswersViewWithCreate',
  itemView: MetadataAnswerViewWithDelete,
  events: {
    "blur .add_answer_form": "hideAddAnswerForm"
  },
  deleteQuestion: function() {
    console.log('delete ' + this.get('pmvid'));
  },
  showAddAnswerForm: function() {
    this.formActive = true;
    this.render();
  },
  hideAddAnswerForm: function() {
    var that = this;
    var formAction = $(event.target).data('action');
    this.serialize(function(attrs){
      alert('add answer for ' + that.model.get('pmkid'));

      var zid = that.model.get('zid');
      var data = {
        zid: zid,
        pmkid: that.model.get('pmkid'),
        value: "new answer " + Math.random(), // attrs.text?
      };
      var model = new MetadataAnswer(data);
      model.save().then(that.collection.fetch({
        data: $.param({
          zid: zid,
          pmkid: that.model.get('pmkid'),
        }), 
        processData: true,
      }));
      that.formActive = false;
      that.render();
    });
  },
  allowCreate: true,
  allowDelete: true,
});

});

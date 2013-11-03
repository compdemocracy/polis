define([
  'view',
  'templates/conversation-details',
  'views/inbox'
], function (View, template, InboxView) {
  return View.extend({
    name: 'conversation-details',
    template: template,
    events: {
      "mouseup input": function(event) {
        console.log('selected');
        $(event.target).select();
      }
    },
    initialize: function(){
    },
    conclude: function(){
      var model = $(event.target).model();
      var deleteConfirm = new konfirm({
        message: 'Concluding the conversation is permanent and will affect all participants. Participants will no longer be able to submit comments or vote.',
        success: function(){
          console.log(model.is_active);
          model.save({is_active: false, is_concluded: true});
          console.log(model.is_active);
        },
        cancel: function(){
          console.log('canceled');
        }
      });
    }
  });
});

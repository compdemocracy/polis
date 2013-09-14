define([
  'view',
  'templates/conversation-details'
], function (View, template) {
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
          console.log(model.is_active)
          model.save({is_active: false, is_concluded: true});
          console.log(model.is_active)
        },
        cancel: function(){
          console.log('canceled');
        }
      });
    },
    delete: function() {
   	  var model = $(event.target).model();
      var deleteConfirm = new konfirm({
      	message: 'Deleting a conversation is permanent. It will affect all participants by concluding the conversation, but will not remove the conversation from their accounts.',
      	success: function(){
  		    model.destroy();
  		    Application.Collections.conversationsCollection.remove(model);
  		    var conversationsView = new Application.Views["conversations"]({
  	          collection: Application.Collections.conversationsCollection,
              active: true
  	        });
            Backbone.history.navigate('/');
  	        Application.setView(conversationsView);
  	        
      	},
      	cancel: function(){
      		console.log('canceled');
      	}
      });
    }
  });
});

define([
  'view',
  'templates/create-conversation-form',
  'models/conversation',
  'views/inbox'
], function (View, template, ConversationModel, InboxView) {
  return View.extend({
    name: 'create-conversation-form',
    template: template,
    events: {
      "click :submit": function(event) {
        var formAction = $(event.target).val();
        $(event.target).parents('form:first').attr('data-action',formAction);
      },
      "submit form": function(event){
        event.preventDefault();
        var formAction = $(event.target).data('action');
        this.serialize(function(attrs){
          if(this.edit===true) {
            switch(formAction) {
              case "draft":
                attrs.is_draft = true;
              break;
              case "publish":
                attrs.is_active = true;
              break;
            }
            this.collection.get(this.id).save(attrs);
            this.collection.sort();
          } else {
            switch(formAction) {
              case "draft":
                attrs.is_draft = true;
              break;
              case "publish":
                attrs.is_active = true;
                attrs.is_draft = false;
              break;
        }
          model = new ConversationModel();
          model.save(attrs);
          Backbone.history.navigate('/#inbox');
        }
        
        var conversationsCollection = new ConversationsCollection(); //every time to replace application??
        conversationsCollection.fetch()
        var inboxView = new InboxView({
           collection: conversationsCollection
        });
        RootView.getInstance().setView(inboxView);
        Backbone.history.navigate('/');
        })
      },
      "invalid": function(errors){ 
        console.log('invalid form input' + errors[0].name);
        console.log(errors);
       //_.each(errors, function(err){
          $('input[name="'+errors[0].name+'"]').closest("label").append(errors[0].message) // relationship between each input and error name
          //'input[name="firstName"]'
        //})
      }
    },
    validateInput: function(attrs){
      var errors = [];
      if(attrs.description === ''){
        errors.push({name: 'description',  message: 'hey there... you need a description'});
      }
      return errors; 
    },
    delete: function() {
      var model = this.collection.get(this.id)
      var deleteConfirm = new konfirm({
        message: 'Conversations cannot be deleted during the Beta.',
        success: function(){
          model.destroy();
          conversationsCollection.remove(model);
          var inboxView = new InboxView({
            collection: conversationsCollection,
            active: true
          });
          Backbone.history.navigate('/');
          RootView.getInstance().setView(inboxView);
        },
        cancel: function(){
          return false;
        }
      });
    },
    saveDraft: function(){
      var model = this.collection.get(this.id)
      model.save()
      RootView.getInstance().setView(inboxView);
      Backbone.history.navigate('/');
    }
  });
});

define([
  'view',
  'templates/create-conversation-form'
], function (View, template) {
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
          model = new Application.Models["conversation"]();
          model.save(attrs);
          this.collection.add(model, {at: 0});
          this.collection.sort();
  
        }
        var conversationsView = new Application.Views["conversations"]({
           collection: Application.Collections.conversationsCollection
        });
        Application.setView(conversationsView);
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
        message: 'You sure about that, bro?',
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
          return false;
        }
      });
    },
    saveDraft: function(){
      var model = this.collection.get(this.id)
      model.save()
      Application.setView(conversationsView);
      Backbone.history.navigate('/');
    }
  });
});

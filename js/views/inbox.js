define([
  'view',
  'templates/inbox'
], function (View, template) {
  return View.extend({
    name: 'inbox',
    template: template,
    events: {
      "mouseup input": function(event) {
        console.log('selected');
        $(event.target).select();
      }
    },
    publish: function(){
      var model = $(event.target).model();
      model.save({is_active: true, is_draft: false});
    }
  });
});

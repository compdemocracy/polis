define([
  'view',
  'templates/create-user-form'
], function (View, template) {
  return View.extend({
    name: 'create-user-form',
    template: template
  });
});

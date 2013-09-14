define([
  'view',
  'templates/login-form'
], function (View, template) {
  return View.extend({
    name: 'login-form',
    template: template
  });
});

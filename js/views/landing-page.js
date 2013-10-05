define([
  'view',
  'templates/landing-page'
], function (View, template) {
  return View.extend({
    name: 'landingPage',
    template: template
  });
});
